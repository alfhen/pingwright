import { runInNewContext } from 'node:vm';
import { newId } from '@pingwright/core';
import { expect, test } from 'vitest';
import { DATALAYER_BINDING, dataLayerEventFromPayload, dataLayerInitScript } from './datalayer.ts';

interface Sent {
  t: number;
  args: string;
}

function pageWith(setup: string): { sent: Sent[]; run: (code: string) => unknown } {
  const sent: Sent[] = [];
  const sandbox: Record<string, unknown> = {
    performance: { timeOrigin: 1000, now: () => 5 },
    Node: class {},
    [DATALAYER_BINDING]: (payload: Sent) => {
      sent.push(payload);
      return Promise.resolve();
    },
  };
  sandbox.window = sandbox;
  runInNewContext(setup + dataLayerInitScript, sandbox);
  return { sent, run: (code) => runInNewContext(code, sandbox) };
}

const argsOf = (sent: Sent[]) => sent.map((s) => JSON.parse(s.args) as unknown);

test('hooks a dataLayer created after the init script', () => {
  const page = pageWith('');
  page.run(`window.dataLayer = window.dataLayer || []; dataLayer.push({ event: 'a' }, { event: 'b' });`);
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
  expect(page.sent[0]?.t).toBe(1005);
});

test('hooks a dataLayer created before the init script, including items already in it', () => {
  const page = pageWith(`window.dataLayer = [{ event: 'early' }];`);
  page.run(`dataLayer.push({ event: 'late' })`);
  expect(argsOf(page.sent)).toEqual([[{ event: 'early' }], [{ event: 'late' }]]);
});

test('a gtag arguments object is reported as its argument list', () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; function gtag() { dataLayer.push(arguments); } gtag('consent', 'update', { ad_storage: 'granted' });`);
  expect(argsOf(page.sent)).toEqual([['consent', 'update', { ad_storage: 'granted' }]]);
});

test('the push still reaches the array and a replaced dataLayer is hooked again', () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' });`);
  expect(page.run('dataLayer.length')).toBe(1);
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
});

test('values that cannot be serialised do not break the push', () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const o = {}; o.self = o; dataLayer.push(o);`);
  expect(argsOf(page.sent)).toEqual([['[unserializable]']]);
  expect(page.run('dataLayer.length')).toBe(1);
});

test('turns payloads into records on the shared clock', () => {
  const runId = newId('run');
  const consent = dataLayerEventFromPayload({ t: 1000, args: '["consent","default",{"ad_storage":"denied"}]' }, runId, 50);
  expect(consent).toMatchObject({
    type: 'dataLayerEvent',
    runId,
    t: 1050,
    event: null,
    isConsentCommand: true,
    args: ['consent', 'default', { ad_storage: 'denied' }],
  });
  const event = dataLayerEventFromPayload(
    { t: 1, args: '[{"event":"purchase","gtm.uniqueEventId":7}]' },
    runId,
    0,
  );
  expect(event).toMatchObject({ event: 'purchase', gtmUniqueEventId: 7, isConsentCommand: false });
  const gtagEvent = dataLayerEventFromPayload({ t: 1, args: '["event","add_to_cart",{}]' }, runId, 0);
  expect(gtagEvent?.event).toBe('add_to_cart');
});

test('malformed payloads are dropped', () => {
  const runId = newId('run');
  expect(dataLayerEventFromPayload({ t: 1, args: 'nope' }, runId, 0)).toBeUndefined();
  expect(dataLayerEventFromPayload({ t: 1, args: '{}' }, runId, 0)).toBeUndefined();
});

test('a push over the size limit keeps its event name and drops the deep values', () => {
  const page = pageWith('');
  page.run(
    `window.dataLayer = []; dataLayer.push({ event: 'purchase', 'gtm.uniqueEventId': 9, ecommerce: { value: 5, items: Array.from({ length: 400 }, (_, i) => ({ item_id: 'SKU' + i, item_name: 'Fake tee ' + i })) } });`,
  );
  expect(page.sent[0]!.args.length).toBeLessThanOrEqual(10000);
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0);
  expect(event).toMatchObject({ event: 'purchase', gtmUniqueEventId: 9, isConsentCommand: false });
  const push = event?.args[0] as { ecommerce: { value: number; items: unknown[] } };
  expect(push.ecommerce.value).toBe(5);
  expect(push.ecommerce.items.every((item) => item === '[truncated]')).toBe(true);
});

test('a large gtag call keeps the command, so a consent update is still a consent command', () => {
  const page = pageWith('');
  page.run(
    `window.dataLayer = []; function gtag() { dataLayer.push(arguments); } gtag('consent', 'update', { analytics_storage: 'granted', note: 'x'.repeat(20000), more: { a: 'y'.repeat(9000) } });`,
  );
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0);
  expect(event).toMatchObject({ isConsentCommand: true });
  expect((event?.args[2] as Record<string, unknown>).analytics_storage).toBe('granted');
});
