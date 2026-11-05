import { runInNewContext } from 'node:vm';
import { newId } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { DATALAYER_BINDING, dataLayerEventFromPayload, dataLayerInitScript } from './datalayer.ts';

const MAIN = { main: true, n: 0 };

interface Sent {
  t: number;
  args: string;
  layer?: string;
}

function pageWith(setup: string, names: string[] = []): { sent: Sent[]; run: (code: string) => unknown } {
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
  runInNewContext(setup + dataLayerInitScript(names), sandbox);
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
  const consent = dataLayerEventFromPayload({ t: 1000, args: '["consent","default",{"ad_storage":"denied"}]' }, runId, 50, MAIN);
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
    MAIN,
  );
  expect(event).toMatchObject({ event: 'purchase', gtmUniqueEventId: 7, isConsentCommand: false });
  const gtagEvent = dataLayerEventFromPayload({ t: 1, args: '["event","add_to_cart",{}]' }, runId, 0, MAIN);
  expect(gtagEvent?.event).toBe('add_to_cart');
});

test('a payload carries the frame flag and number it is given', () => {
  const runId = newId('run');
  const payload = { t: 1, args: '[{"event":"x"}]' };
  const first = dataLayerEventFromPayload(payload, runId, 0, { main: false, n: 3 });
  expect(first?.frame).toEqual({ main: false, n: 3 });
  expect(dataLayerEventFromPayload(payload, runId, 0, MAIN)?.frame).toEqual({ main: true, n: 0 });
});

test('malformed payloads are dropped', () => {
  const runId = newId('run');
  expect(dataLayerEventFromPayload({ t: 1, args: 'nope' }, runId, 0, MAIN)).toBeUndefined();
  expect(dataLayerEventFromPayload({ t: 1, args: '{}' }, runId, 0, MAIN)).toBeUndefined();
});

test('a push over the size limit keeps its event name and drops the deep values', () => {
  const page = pageWith('');
  page.run(
    `window.dataLayer = []; dataLayer.push({ event: 'purchase', 'gtm.uniqueEventId': 9, ecommerce: { value: 5, items: Array.from({ length: 400 }, (_, i) => ({ item_id: 'SKU' + i, item_name: 'Fake tee ' + i })) } });`,
  );
  expect(page.sent[0]!.args.length).toBeLessThanOrEqual(10000);
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0, MAIN);
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
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0, MAIN);
  expect(event).toMatchObject({ isConsentCommand: true });
  expect((event?.args[2] as Record<string, unknown>).analytics_storage).toBe('granted');
});

test('a named layer is hooked and its pushes carry the layer name', () => {
  const page = pageWith('', ['myLayer']);
  page.run(`window.myLayer = window.myLayer || []; myLayer.push({ event: 'a' }); window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  expect(page.sent.map((s) => s.layer)).toEqual(['myLayer', undefined]);
  expect(page.run('myLayer.length')).toBe(1);
  const runId = newId('run');
  expect(dataLayerEventFromPayload(page.sent[0]!, runId, 0, MAIN)?.layer).toBe('myLayer');
  expect(dataLayerEventFromPayload(page.sent[1]!, runId, 0, MAIN)).not.toHaveProperty('layer');
});

test('a layer name that is not an identifier is dropped from the payload', () => {
  const runId = newId('run');
  expect(dataLayerEventFromPayload({ t: 1, args: '[{"event":"x"}]', layer: 'a b' }, runId, 0, MAIN)).not.toHaveProperty('layer');
  expect(dataLayerEventFromPayload({ t: 1, args: '[{"event":"x"}]', layer: 'dataLayer' }, runId, 0, MAIN)).not.toHaveProperty('layer');
});

test('a name is trapped only when absent or a configurable array', () => {
  const page = pageWith(
    `Object.defineProperty(window, 'fixed', { value: [], configurable: false }); window.early = [{ event: 'early' }];`,
    ['fixed', 'Shopify', 'early', 'location', '__proto__', 'constructor', 'prototype', 'toString'],
  );
  page.run(`early.push({ event: 'late' });`);
  expect(page.sent.map((s) => s.layer)).toEqual(['early', 'early']);
  expect(page.run(`Object.getOwnPropertyDescriptor(window, 'Shopify')`)).toBeUndefined();
  expect(page.run(`Object.getOwnPropertyDescriptor(window, 'fixed').value.length`)).toBe(0);
  expect(page.run(`Object.prototype.hasOwnProperty.call(window, 'toString')`)).toBe(false);
});

test('names outside the identifier pattern never reach the script', () => {
  const script = dataLayerInitScript(['ok', 'x"; alert(1); "', 'a-b']);
  expect(script).toContain('["dataLayer","ok"]');
  expect(script).not.toContain('alert');
});

test('Shopify and location are not trapped while absent', () => {
  expect(dataLayerInitScript(['Shopify', 'location', 'ok'])).toContain('["dataLayer","ok"]');
  const page = pageWith('', ['Shopify', 'location']);
  expect(page.run(`Object.getOwnPropertyDescriptor(window, 'Shopify')`)).toBeUndefined();
  expect(page.run(`Object.getOwnPropertyDescriptor(window, 'location')`)).toBeUndefined();
  page.run(`window.Shopify = { theme: 1 };`);
  expect(page.run(`Object.getOwnPropertyDescriptor(window, 'Shopify').value.theme`)).toBe(1);
});
