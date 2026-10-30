import type { DataLayerEvent } from '@pingwright/core';
import { describe, expect, test } from 'vitest';
import { consentModeChanges, type ConsentPush } from './consent-mode.ts';
import { buildEpochs, type BannerEvent } from './epochs.ts';

const denied = {
  ad_storage: 'denied',
  analytics_storage: 'denied',
  ad_user_data: 'denied',
  ad_personalization: 'denied',
};
const granted = {
  ad_storage: 'granted',
  analytics_storage: 'granted',
  ad_user_data: 'granted',
  ad_personalization: 'granted',
};

const push = (t: number, command: 'default' | 'update', signals: Record<string, string>): ConsentPush => ({
  t,
  args: ['consent', command, signals],
});

describe('consentModeChanges', () => {
  test('merges updates into the earlier state', () => {
    const changes = consentModeChanges([
      push(20, 'update', { analytics_storage: 'granted' }),
      push(10, 'default', denied),
      { t: 15, args: ['event', 'page_view', {}] },
    ]);
    expect(changes.map((c) => [c.t, c.command])).toEqual([
      [10, 'default'],
      [20, 'update'],
    ]);
    expect(changes[1]?.state).toEqual({ analytics: 'granted', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' });
  });

  test('ignores a region-scoped default', () => {
    const changes = consentModeChanges([
      push(1, 'default', { ...denied, region: ['DK', 'SE'] } as unknown as Record<string, string>),
      push(2, 'default', { analytics_storage: 'granted' }),
    ]);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.state.ads).toBe('unknown');
    expect(changes[0]?.state.analytics).toBe('granted');
  });

  test('accepts full dataLayer event records', () => {
    const record: DataLayerEvent = {
      type: 'dataLayerEvent',
      id: 'dle_1' as DataLayerEvent['id'],
      runId: 'run_1' as DataLayerEvent['runId'],
      stepId: null,
      t: 5,
      event: null,
      gtmUniqueEventId: null,
      args: ['consent', 'default', denied],
      isConsentCommand: true,
    };
    expect(consentModeChanges([record])[0]?.state.analytics).toBe('denied');
  });

  test('treats missing signals as unknown', () => {
    const [change] = consentModeChanges([push(1, 'default', { ad_storage: 'denied' })]);
    expect(change?.state).toEqual({ analytics: 'unknown', ads: 'denied', adUserData: 'unknown', adPersonalization: 'unknown' });
  });

  test('skips pushes whose args is a plain object', () => {
    const changes = consentModeChanges([{ t: 1, args: { event: 'gtm.js' } as never }, push(2, 'default', { ad_storage: 'denied' })]);
    expect(changes).toHaveLength(1);
  });
});

describe('buildEpochs', () => {
  test('a default after the first decision does not leak into later states when the caller omits firstDecisionT', () => {
    const modes = consentModeChanges([
      push(10, 'default', denied),
      push(5000, 'default', { analytics_storage: 'granted' }),
      push(20000, 'update', { ad_storage: 'granted' }),
    ]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 1010, action: 'reject' }], modes, { startT: 0 });
    expect(epochs.at(-1)?.state.analytics).toBe('denied');
    expect(epochs.at(-1)?.state.ads).toBe('granted');
  });

  test('undecided only', () => {
    const epochs = buildEpochs([], consentModeChanges([push(10, 'default', denied)]), { startT: 0 });
    expect(epochs).toHaveLength(1);
    expect(epochs[0]).toMatchObject({ startT: 0, endT: null, label: 'undecided', source: 'start' });
    expect(epochs[0]?.state.analytics).toBe('denied');
  });

  test('accept starts an epoch at the banner event, which is earlier than the update', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(1130, 'update', granted)]);
    const epochs = buildEpochs([{ t: 1100, action: 'accept' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.endT, e.source])).toEqual([
      ['undecided', 0, 1100, 'start'],
      ['granted', 1100, null, 'banner'],
    ]);
  });

  test('reject starts at the update when it comes first', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(1090, 'update', denied)]);
    const epochs = buildEpochs([{ t: 1100, action: 'reject' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.source])).toEqual([
      ['undecided', 0, 'start'],
      ['denied', 1090, 'consentMode'],
    ]);
  });

  test('an update during a multi-step action starts the epoch at the update', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(1900, 'update', granted)]);
    const epochs = buildEpochs([{ t: 1100, tEnd: 1905, action: 'accept' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.source])).toEqual([
      ['undecided', 0, 'start'],
      ['granted', 1900, 'consentMode'],
    ]);
  });

  test('split defaults and an all-denied load-time update give one undecided epoch', () => {
    const modes = consentModeChanges([
      push(10, 'default', { ad_storage: 'denied', analytics_storage: 'denied' }),
      push(11, 'default', { ad_user_data: 'denied', ad_personalization: 'denied' }),
      push(300, 'update', denied),
    ]);
    const epochs = buildEpochs([], modes, { startT: 0 });
    expect(epochs.map((e) => e.label)).toEqual(['undecided']);
    expect(epochs[0]?.state.adUserData).toBe('denied');
  });

  test('a two-signal default and a four-signal denied load-time update give one undecided epoch', () => {
    const modes = consentModeChanges([
      push(10, 'default', { ad_storage: 'denied', analytics_storage: 'denied' }),
      push(300, 'update', denied),
    ]);
    const epochs = buildEpochs([], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.endT])).toEqual([['undecided', 0, null]]);
    expect(epochs[0]?.state.adUserData).toBe('denied');
  });

  test('a load-time update that grants without a banner still starts an epoch', () => {
    const modes = consentModeChanges([
      push(10, 'default', { ad_storage: 'denied', analytics_storage: 'denied' }),
      push(300, 'update', granted),
    ]);
    const epochs = buildEpochs([], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT])).toEqual([['undecided', 0], ['granted', 300]]);
  });

  test('a load-time update repeating the default adds no epoch', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(100, 'update', denied)]);
    const epochs = buildEpochs([], modes, { startT: 0 });
    expect(epochs.map((e) => e.label)).toEqual(['undecided']);
  });

  test('a load-time denied update followed by a later reject starts the denied epoch at the reject', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(100, 'update', denied), push(1630, 'update', denied)]);
    const epochs = buildEpochs([{ t: 1600, action: 'reject' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.endT, e.source])).toEqual([
      ['undecided', 0, 1600, 'start'],
      ['denied', 1600, null, 'banner'],
    ]);
  });

  test('accept then withdraw gives three epochs', () => {
    const modes = consentModeChanges([
      push(10, 'default', denied),
      push(1100, 'update', granted),
      push(3100, 'update', denied),
    ]);
    const epochs = buildEpochs(
      [
        { t: 1090, action: 'accept' },
        { t: 3080, action: 'reject' },
      ],
      modes,
      { startT: 0 },
    );
    expect(epochs.map((e) => [e.label, e.startT, e.endT])).toEqual([
      ['undecided', 0, 1090],
      ['granted', 1090, 3080],
      ['withdrawn', 3080, null],
    ]);
    expect(epochs[2]?.state).toEqual({ analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' });
  });

  test('an accept with no update followed by a quick reject is not paired with the reject update', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(2510, 'update', denied)]);
    const epochs = buildEpochs(
      [
        { t: 1000, action: 'accept' },
        { t: 2500, action: 'reject' },
      ],
      modes,
      { startT: 0 },
    );
    expect(epochs.map((e) => [e.label, e.startT])).toEqual([
      ['undecided', 0],
      ['granted', 1000],
      ['withdrawn', 2500],
    ]);
    expect(epochs[1]?.state.analytics).toBe('granted');
  });

  test('a reject paired with a granting update keeps the banner label and the update state', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(1010, 'update', granted)]);
    const epochs = buildEpochs([{ t: 1000, action: 'reject' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT])).toEqual([
      ['undecided', 0],
      ['denied', 1000],
    ]);
    expect(epochs[1]?.state.analytics).toBe('granted');
  });

  test('a two-signal accept is one epoch from the banner event', () => {
    const v1 = { ad_storage: 'denied', analytics_storage: 'denied' };
    const modes = consentModeChanges([
      push(10, 'default', v1),
      push(1030, 'update', { ad_storage: 'granted', analytics_storage: 'granted' }),
    ]);
    const epochs = buildEpochs([{ t: 1000, action: 'accept' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.endT, e.source])).toEqual([
      ['undecided', 0, 1000, 'start'],
      ['granted', 1000, null, 'banner'],
    ]);
  });

  test('a partial accept is one epoch carrying the Consent Mode state', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(1020, 'update', { analytics_storage: 'granted' })]);
    const epochs = buildEpochs([{ t: 1000, action: 'accept' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.endT])).toEqual([
      ['undecided', 0, 1000],
      ['granted', 1000, null],
    ]);
    expect(epochs[1]?.state).toEqual({ analytics: 'granted', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' });
  });

  test.each(['accept', 'reject'] as const)('a two-signal %s re-sent outside the window adds no epoch', (action) => {
    const signals = { ad_storage: action === 'accept' ? 'granted' : 'denied', analytics_storage: action === 'accept' ? 'granted' : 'denied' };
    const modes = consentModeChanges([
      push(10, 'default', { ad_storage: 'denied', analytics_storage: 'denied' }),
      push(1030, 'update', signals),
      push(8000, 'default', { ad_storage: 'denied', analytics_storage: 'denied' }),
      push(8001, 'update', signals),
    ]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 1040, action }], modes, { startT: 0 });
    expect(epochs.map((e) => e.label)).toEqual(['undecided', action === 'accept' ? 'granted' : 'denied']);
  });

  test('a default after a banner decision with no update does not reach later states', () => {
    const modes = consentModeChanges(
      [push(10, 'default', denied), push(5000, 'default', { analytics_storage: 'granted' }), push(20000, 'update', { ad_storage: 'granted' })],
      1000,
    );
    expect(modes.map((c) => c.t)).toEqual([10, 20000]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 1010, action: 'reject' }], modes, { startT: 0 });
    expect(epochs.at(-1)?.state.analytics).toBe('denied');
  });

  test('an accept sent as several updates is one epoch with the last state', () => {
    const modes = consentModeChanges([
      push(10, 'default', denied),
      push(1010, 'update', { analytics_storage: 'granted' }),
      push(1020, 'update', { ad_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' }),
    ]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 1050, action: 'accept' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT, e.endT])).toEqual([
      ['undecided', 0, 1010],
      ['granted', 1010, null],
    ]);
    expect(epochs[1]?.state).toEqual({ analytics: 'granted', ads: 'granted', adUserData: 'granted', adPersonalization: 'granted' });
  });

  test('several updates that end in the same state as one update keep the action label', () => {
    const modes = consentModeChanges([
      push(10, 'default', denied),
      push(1010, 'update', { analytics_storage: 'granted', ad_storage: 'granted' }),
      push(1020, 'update', { ad_user_data: 'granted' }),
    ]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 1050, action: 'accept' }], modes, { startT: 0 });
    expect(epochs.map((e) => e.label)).toEqual(['undecided', 'granted']);
  });

  test('a reject sent as two updates is one denied epoch', () => {
    const modes = consentModeChanges([
      push(10, 'default', granted),
      push(1010, 'update', { analytics_storage: 'denied' }),
      push(1020, 'update', { ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }),
    ]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 1050, action: 'reject' }], modes, { startT: 0 });
    expect(epochs.map((e) => [e.label, e.startT])).toEqual([
      ['undecided', 0],
      ['denied', 1010],
    ]);
  });

  test('a banner event without a Consent Mode update still starts an epoch', () => {
    const epochs = buildEpochs([{ t: 500, action: 'accept' }], [], { startT: 0 });
    expect(epochs.map((e) => e.label)).toEqual(['undecided', 'granted']);
  });

  test('an update repeating the current state adds no epoch', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(100, 'update', granted), push(200, 'update', granted)]);
    expect(buildEpochs([], modes, { startT: 0 })).toHaveLength(2);
  });

  test('a long accept with a partial update is one epoch carrying the Consent Mode state', () => {
    const partial = { ...granted, ads: 'denied' };
    const modes = consentModeChanges([push(10, 'default', denied), push(6000, 'update', partial)]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 5000, action: 'accept' }], modes, { startT: 0 });
    expect(epochs).toHaveLength(2);
    expect(epochs[1]!.startT).toBe(5000);
    expect(epochs[1]!.state).toEqual(modes.find((m) => m.command === 'update')!.state);
  });

  test('a long reject with an all-denied update starts the epoch at the update', () => {
    const modes = consentModeChanges([push(10, 'default', granted), push(3500, 'update', denied)]);
    const epochs = buildEpochs([{ t: 1000, tEnd: 5000, action: 'reject' }], modes, { startT: 0 });
    expect(epochs).toHaveLength(2);
    expect(epochs[1]!.startT).toBe(3500);
    expect(epochs[1]!.label).toBe('denied');
  });
});

describe('labelOf', () => {
  test('ignores unknown fields', () => {
    const modes = consentModeChanges([push(1000, 'update', { analytics_storage: 'granted', ad_storage: 'granted' })]);
    const epochs = buildEpochs([], modes, { startT: 0 });
    expect(epochs.at(-1)?.label).toBe('granted');
  });
});

describe('later Consent Mode defaults', () => {
  const changes = (...pushes: ConsentPush[]) => consentModeChanges(pushes);

  test('a default after an accept starts no epoch', () => {
    const epochs = buildEpochs(
      [{ t: 1000, tEnd: 1010, action: 'accept' }],
      changes(push(10, 'default', denied), push(1005, 'update', granted), push(3000, 'default', denied)),
      { startT: 0 },
    );
    expect(epochs.map((e) => [e.label, e.startT])).toEqual([
      ['undecided', 0],
      ['granted', 1005],
    ]);
  });

  test('a default after an accept does not change the state of a later update', () => {
    const epochs = buildEpochs(
      [{ t: 1000, tEnd: 1010, action: 'accept' }],
      changes(
        push(10, 'default', denied),
        push(1005, 'update', granted),
        push(10000, 'default', denied),
        push(20000, 'update', { ad_storage: 'granted' }),
      ),
      { startT: 0 },
    );
    expect(epochs.map((e) => [e.label, e.startT])).toEqual([
      ['undecided', 0],
      ['granted', 1005],
    ]);
  });

  test('several defaults before the first decision merge into the undecided state', () => {
    const epochs = buildEpochs([], changes(push(10, 'default', { analytics_storage: 'denied' }), push(20, 'default', { ad_storage: 'denied' })), { startT: 0 });
    expect(epochs).toHaveLength(1);
    expect(epochs[0]?.state).toMatchObject({ analytics: 'denied', ads: 'denied' });
  });

  describe('withdrawn label', () => {
    const analyticsOnly = { ...denied, analytics_storage: 'granted' };
    const labelsFor = (states: Record<string, string>[], banners: BannerEvent[] = []) => {
      const updates = states.map((s, i) => push(1000 * (i + 1), 'update', s));
      return buildEpochs(banners, consentModeChanges([push(10, 'default', denied), ...updates]), { startT: 0 }).map((e) => e.label);
    };

    test('a banner reject that denies only some signals keeps its denied outcome', () => {
      const banners: BannerEvent[] = [{ t: 1000, action: 'accept' }, { t: 3000, action: 'reject' }];
      const updates = [push(1000, 'update', granted), push(3000, 'update', { analytics_storage: 'denied', ad_storage: 'denied' })];
      const epochs = buildEpochs(banners, consentModeChanges([push(10, 'default', denied), ...updates]), { startT: 0 });
      expect(epochs.map((e) => [e.label, e.outcome])).toEqual([['undecided', undefined], ['granted', undefined], ['withdrawn', 'denied']]);
    });

    test('granted then denied', () => {
      expect(labelsFor([granted, denied])).toEqual(['undecided', 'granted', 'withdrawn']);
    });

    test('granted then mixed', () => {
      expect(labelsFor([granted, analyticsOnly])).toEqual(['undecided', 'granted', 'withdrawn']);
    });

    test('mixed then denied', () => {
      expect(labelsFor([analyticsOnly, denied])).toEqual(['undecided', 'mixed', 'withdrawn']);
    });

    test('granted, mixed, denied', () => {
      expect(labelsFor([granted, analyticsOnly, denied])).toEqual(['undecided', 'granted', 'withdrawn', 'withdrawn']);
    });

    test('granted, denied, granted, denied', () => {
      expect(labelsFor([granted, denied, granted, denied])).toEqual(['undecided', 'granted', 'withdrawn', 'granted', 'withdrawn']);
    });

    test('a first reject is not a withdrawal', () => {
      expect(labelsFor([], [{ t: 1000, action: 'reject' }])).toEqual(['undecided', 'denied']);
    });

    test('a signal that was never granted is not withdrawn', () => {
      expect(labelsFor([analyticsOnly, { ...analyticsOnly, ad_storage: 'granted' }])).toEqual(['undecided', 'mixed', 'mixed']);
    });

    test('a granted default before the decision does not make the first reject a withdrawal', () => {
      const modes = consentModeChanges([push(10, 'default', granted), push(1000, 'update', denied)]);
      expect(buildEpochs([{ t: 1000, action: 'reject' }], modes, { startT: 0 }).map((e) => e.label)).toEqual(['undecided', 'denied']);
    });
  });
});
