import { runInNewContext } from 'node:vm';
import { newId } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { DATALAYER_BINDING, DATALAYER_TALLY, dataLayerEventFromPayload, dataLayerInitScript } from './datalayer.ts';

const MAIN = { main: true, n: 0 };

interface Sent {
  t: number;
  args: string;
  layer?: string;
  d?: string;
  a?: number;
  uid?: number;
  reassigned?: true;
}

function pageWith(setup: string, names: string[] = []): { sent: Sent[]; run: (code: string) => unknown; flush: () => Promise<void> } {
  const sent: Sent[] = [];
  const sandbox: Record<string, unknown> = {
    performance: { timeOrigin: 1000, now: () => 5 },
    Node: class {},
    queueMicrotask,
    addEventListener: () => {},
    [DATALAYER_BINDING]: (payload: Sent) => {
      sent.push(payload);
      return Promise.resolve();
    },
  };
  sandbox.window = sandbox;
  runInNewContext(setup + dataLayerInitScript(names), sandbox);
  return { sent, run: (code) => runInNewContext(code, sandbox), flush: () => new Promise((resolve) => setTimeout(resolve, 0)) };
}

const argsOf = (sent: Sent[]) => sent.map((s) => JSON.parse(s.args) as unknown);

test('hooks a dataLayer created after the init script', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = window.dataLayer || []; dataLayer.push({ event: 'a' }, { event: 'b' });`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
  expect(page.sent[0]?.t).toBe(1005);
});

test('hooks a dataLayer created before the init script, including items already in it', async () => {
  const page = pageWith(`window.dataLayer = [{ event: 'early' }];`);
  page.run(`dataLayer.push({ event: 'late' })`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'early' }], [{ event: 'late' }]]);
});

test('a gtag arguments object is reported as its argument list', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; function gtag() { dataLayer.push(arguments); } gtag('consent', 'update', { ad_storage: 'granted' });`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([['consent', 'update', { ad_storage: 'granted' }]]);
});

test('the push still reaches the array and a replaced dataLayer is hooked again', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' });`);
  expect(page.run('dataLayer.length')).toBe(1);
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  await page.flush();
  expect(argsOf(page.sent.filter((s) => !s.reassigned))).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
});

test('values that cannot be serialised do not break the push', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const o = {}; o.self = o; dataLayer.push(o);`);
  await page.flush();
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

test('a push over the size limit keeps its event name and drops the deep values', async () => {
  const page = pageWith('');
  page.run(
    `window.dataLayer = []; dataLayer.push({ event: 'purchase', 'gtm.uniqueEventId': 9, ecommerce: { value: 5, items: Array.from({ length: 400 }, (_, i) => ({ item_id: 'SKU' + i, item_name: 'Fake tee ' + i })) } });`,
  );
  await page.flush();
  expect(page.sent[0]!.args.length).toBeLessThanOrEqual(10000);
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0, MAIN);
  expect(event).toMatchObject({ event: 'purchase', gtmUniqueEventId: 9, isConsentCommand: false });
  const push = event?.args[0] as { ecommerce: { value: number; items: unknown[] } };
  expect(push.ecommerce.value).toBe(5);
  expect(push.ecommerce.items.every((item) => item === '[truncated]')).toBe(true);
});

test('a large gtag call keeps the command, so a consent update is still a consent command', async () => {
  const page = pageWith('');
  page.run(
    `window.dataLayer = []; function gtag() { dataLayer.push(arguments); } gtag('consent', 'update', { analytics_storage: 'granted', note: 'x'.repeat(20000), more: { a: 'y'.repeat(9000) } });`,
  );
  await page.flush();
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0, MAIN);
  expect(event).toMatchObject({ isConsentCommand: true });
  expect((event?.args[2] as Record<string, unknown>).analytics_storage).toBe('granted');
});

test('a named layer is hooked and its pushes carry the layer name', async () => {
  const page = pageWith('', ['myLayer']);
  page.run(`window.myLayer = window.myLayer || []; myLayer.push({ event: 'a' }); window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  await page.flush();
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

test('a name is trapped only when absent or a configurable array', async () => {
  const page = pageWith(
    `Object.defineProperty(window, 'fixed', { value: [], configurable: false }); window.early = [{ event: 'early' }];`,
    ['fixed', 'Shopify', 'early', 'location', '__proto__', 'constructor', 'prototype', 'toString'],
  );
  page.run(`early.push({ event: 'late' });`);
  await page.flush();
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

type Tally = { d: string; arrays: { layer: string; a: number | null; length: number; posted: number }[] };

test('the tally returns the token, array number, length and posted count', async () => {
  const page = pageWith('', ['myLayer']);
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' }, { event: 'b' }); window.myLayer = [{ event: 'c' }];`);
  const tally = page.run(`${DATALAYER_TALLY}()`) as Tally;
  expect(typeof tally.d).toBe('string');
  expect(tally.arrays).toEqual([
    { layer: 'dataLayer', a: 1, length: 2, posted: 2 },
    { layer: 'myLayer', a: 1, length: 1, posted: 1 },
  ]);
  await page.flush();
  expect(page.sent.map((s) => [s.d, s.a])).toEqual([[tally.d, 1], [tally.d, 1], [tally.d, 1]]);
});

test('a replaced array gets the next array number and an unhooked array reports a null', () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' }); window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  expect((page.run(`${DATALAYER_TALLY}()`) as Tally).arrays).toEqual([{ layer: 'dataLayer', a: 2, length: 1, posted: 1 }]);
  page.run(`Object.defineProperty(window, 'dataLayer', { value: [1, 2, 3], configurable: true });`);
  expect((page.run(`${DATALAYER_TALLY}()`) as Tally).arrays).toEqual([{ layer: 'dataLayer', a: null, length: 3, posted: 0 }]);
});

test('two documents get different tokens', () => {
  const first = pageWith('').run(`${DATALAYER_TALLY}()`) as Tally;
  const second = pageWith('').run(`${DATALAYER_TALLY}()`) as Tally;
  expect(first.d).not.toBe(second.d);
  expect(first.d.length).toBeLessThanOrEqual(64);
});

test('the tally posts nothing and never throws into the page', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' });`);
  page.run(`${DATALAYER_TALLY}(); ${DATALAYER_TALLY}()`);
  await page.flush();
  expect(page.sent).toHaveLength(1);
  page.run(`Object.defineProperty(window, 'dataLayer', { get() { throw new Error('x'); }, configurable: true });`);
  expect(() => page.run(`${DATALAYER_TALLY}()`)).not.toThrow();
});

test('the tally catches up a push that skipped the base and counts it as posted while its post is queued', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; window.saved = dataLayer; Array.prototype.push.call(saved, { event: 'a' });`);
  expect((page.run(`${DATALAYER_TALLY}()`) as Tally).arrays).toEqual([{ layer: 'dataLayer', a: 1, length: 1, posted: 1 }]);
  expect(page.sent).toHaveLength(0);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }]]);
  expect((page.run(`${DATALAYER_TALLY}()`) as Tally).arrays[0]).toMatchObject({ length: 1, posted: 1 });
  expect(page.sent).toHaveLength(1);
});

const WRAP_THROUGH = `window.dataLayer = window.dataLayer || [];
  const saved = dataLayer.push; let id = 100;
  dataLayer.push = function () { const r = saved.apply(this, arguments); for (const i of arguments) i['gtm.uniqueEventId'] = ++id; return r; };`;

test('a call-through wrapper is recorded once per push and its id is read after the push returns', async () => {
  const page = pageWith('');
  page.run(`${WRAP_THROUGH} dataLayer.push({ event: 'a' }); dataLayer.push({ event: 'b' });`);
  await page.flush();
  expect(page.sent.map((s) => [JSON.parse(s.args)[0].event, s.uid])).toEqual([['a', 101], ['b', 102]]);
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0, MAIN);
  expect(event?.gtmUniqueEventId).toBe(101);
});

test('push returns exactly the function the page assigned last', () => {
  const page = pageWith('');
  expect(page.run(`window.dataLayer = []; const mine = function () { return 1; }; dataLayer.push = mine; dataLayer.push === mine`)).toBe(true);
  expect(page.run(`dataLayer.push = Array.prototype.push; dataLayer.push === Array.prototype.push`)).toBe(true);
});

test('a wrapper that drops the push records nothing for it', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'before' }); dataLayer.push = function () { return dataLayer.length; }; dataLayer.push({ event: 'dropped' });`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'before' }]]);
});

test('an assigned native push is recorded by the growth check, in order', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push = Array.prototype.push; dataLayer.push({ event: 'a' }, { event: 'b' }); dataLayer.push({ event: 'c' });`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }], [{ event: 'c' }]]);
  expect(page.run('dataLayer.length')).toBe(3);
});

test('an identity-guarded wrapper installed three times runs twice and records each push once', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; window.runs = 0; let saved, mine;
    const install = () => { if (dataLayer.push === mine) return; saved = dataLayer.push; mine = function () { runs++; return saved.apply(this, arguments); }; dataLayer.push = mine; };
    install(); install(); install(); dataLayer.push({ event: 'a' });`);
  await page.flush();
  expect(page.run('runs')).toBe(1);
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }]]);
});

test('an in-place edit in front of the known items is not recorded, and a repeated item is recorded twice', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const o = { event: 'o' }; dataLayer.push(o); dataLayer.push(o); Array.prototype.unshift.call(dataLayer, { event: 'u' });`);
  page.run(`dataLayer.push`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'o' }], [{ event: 'o' }]]);
  page.run(`dataLayer.push({ event: 'after' })`);
  await page.flush();
  expect(argsOf(page.sent).at(-1)).toEqual([{ event: 'after' }]);
});

test('a sort or a front splice resets what is known and records nothing', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'b' }, { event: 'a' }); dataLayer.sort((x, y) => x.event.localeCompare(y.event)); dataLayer.splice(0, 1);`);
  page.run(`dataLayer.push`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'b' }], [{ event: 'a' }]]);
});

test('an unshift into an empty hooked array is recorded as appends in order', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; Array.prototype.unshift.call(dataLayer, { event: 'a' }, { event: 'b' });`);
  page.run(`dataLayer.push`);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
});

test('window.dataLayer = window.dataLayer || [] keeps the sync, so a later native push is recorded', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = window.dataLayer || []; window.dataLayer = window.dataLayer || []; window.saved = dataLayer;`);
  page.run(`Array.prototype.push.call(saved, { event: 'late' });`);
  expect((page.run(`${DATALAYER_TALLY}()`) as Tally).arrays).toEqual([{ layer: 'dataLayer', a: 1, length: 1, posted: 1 }]);
  await page.flush();
  expect(argsOf(page.sent)).toEqual([[{ event: 'late' }]]);
});

test('a throwing getter on an item does not reach the page', async () => {
  const page = pageWith('');
  expect(() => page.run(`window.dataLayer = []; const o = { get event() { throw new Error('x'); }, get 'gtm.uniqueEventId'() { throw new Error('y'); } }; dataLayer.push(o); dataLayer.push({ event: 'ok' });`)).not.toThrow();
  await page.flush();
  expect(argsOf(page.sent)).toEqual([['[unserializable]'], [{ event: 'ok' }]]);
});

test('a throwing element getter on the array does not reach the page', async () => {
  const page = pageWith('');
  expect(() => page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' }); Object.defineProperty(dataLayer, 1, { get() { throw new Error('x'); }, configurable: true }); dataLayer.length = 2; dataLayer.push({ event: 'b' }); dataLayer.push;`)).not.toThrow();
  await page.flush();
});

test('replacing window.dataLayer with a new array posts a reassigned notice and keeps recording', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' }); window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  await page.flush();
  expect(page.sent.filter((s) => s.reassigned)).toHaveLength(1);
  expect(page.sent.find((s) => s.reassigned)).toMatchObject({ args: '[]' });
  expect(argsOf(page.sent.filter((s) => !s.reassigned))).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
  expect(dataLayerEventFromPayload(page.sent.find((s) => s.reassigned)!, newId('run'), 0, MAIN)).toBeUndefined();
});

test('assigning the same array again posts no reassigned notice', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = window.dataLayer || []; window.dataLayer = window.dataLayer || [];`);
  await page.flush();
  expect(page.sent.filter((s) => s.reassigned)).toHaveLength(0);
});

test('the tally reading the name queues no second check', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; window.saved = dataLayer; Array.prototype.push.call(saved, { event: 'a' });`);
  page.run(`${DATALAYER_TALLY}()`);
  await page.flush();
  expect(page.sent).toHaveLength(1);
});
