import { describe, expect, test } from 'vitest';
import { consentModeChanges, type ConsentPush } from './consent-mode.ts';
import { buildEpochs, epochsForHit } from './epochs.ts';

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

  test('treats missing signals as unknown', () => {
    const [change] = consentModeChanges([push(1, 'default', { ad_storage: 'denied' })]);
    expect(change?.state).toEqual({ analytics: 'unknown', ads: 'denied', adUserData: 'unknown', adPersonalization: 'unknown' });
  });
});

describe('buildEpochs', () => {
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
      ['denied', 3080, null],
    ]);
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
    expect(epochsForHit(epochs, 5000).map((e) => e.label)).toEqual(['granted']);
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

  test('a banner event without a Consent Mode update still starts an epoch', () => {
    const epochs = buildEpochs([{ t: 500, action: 'accept' }], [], { startT: 0 });
    expect(epochs.map((e) => e.label)).toEqual(['undecided', 'granted']);
  });

  test('an update repeating the current state adds no epoch', () => {
    const modes = consentModeChanges([push(10, 'default', denied), push(100, 'update', granted), push(200, 'update', granted)]);
    expect(buildEpochs([], modes, { startT: 0 })).toHaveLength(2);
  });
});

describe('epochsForHit', () => {
  const modes = consentModeChanges([push(10, 'default', denied), push(1000, 'update', granted)]);
  const epochs = buildEpochs([], modes, { startT: 0 });

  test('a hit within the grace window of an update matches both epochs', () => {
    expect(epochsForHit(epochs, 1030).map((e) => e.label)).toEqual(['undecided', 'granted']);
  });

  test('a hit after the grace window matches only the new epoch', () => {
    expect(epochsForHit(epochs, 1050).map((e) => e.label)).toEqual(['granted']);
    expect(epochsForHit(epochs, 1030, 20).map((e) => e.label)).toEqual(['granted']);
  });

  test('a hit before the update matches the first epoch', () => {
    expect(epochsForHit(epochs, 900).map((e) => e.label)).toEqual(['undecided']);
  });
});
