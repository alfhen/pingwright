import { runInNewContext } from 'node:vm';
import { newId } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { DATALAYER_BINDING, dataLayerEventFromPayload, dataLayerInitScript } from './datalayer.ts';

const MAIN = { main: true, n: 0 };

interface Sent {
  t: number;
  args: string;
  uid?: number;
  reassigned?: true;
}

function pageWith(setup: string): { sent: Sent[]; run: (code: string) => unknown; settle: () => Promise<void> } {
  const sent: Sent[] = [];
  const sandbox: Record<string, unknown> = {
    performance: { timeOrigin: 1000, now: () => 5 },
    Node: class {},
    queueMicrotask,
    [DATALAYER_BINDING]: (payload: Sent) => {
      sent.push(payload);
      return Promise.resolve();
    },
  };
  sandbox.window = sandbox;
  runInNewContext(setup + dataLayerInitScript, sandbox);
  return { sent, run: (code) => runInNewContext(code, sandbox), settle: () => new Promise((r) => setTimeout(r, 5)) };
}

const argsOf = (sent: Sent[]) => sent.filter((s) => !s.reassigned).map((s) => JSON.parse(s.args) as unknown);

test('hooks a dataLayer created after the init script', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = window.dataLayer || []; dataLayer.push({ event: 'a' }, { event: 'b' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
  await page.settle();
  expect(page.sent[0]?.t).toBe(1005);
});

test('hooks a dataLayer created before the init script, including items already in it', async () => {
  const page = pageWith(`window.dataLayer = [{ event: 'early' }];`);
  page.run(`dataLayer.push({ event: 'late' })`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'early' }], [{ event: 'late' }]]);
});

test('a gtag arguments object is reported as its argument list', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; function gtag() { dataLayer.push(arguments); } gtag('consent', 'update', { ad_storage: 'granted' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([['consent', 'update', { ad_storage: 'granted' }]]);
});

test('the push still reaches the array and a replaced dataLayer is hooked again', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'a' });`);
  expect(page.run('dataLayer.length')).toBe(1);
  page.run(`window.dataLayer = []; dataLayer.push({ event: 'b' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
});

test('values that cannot be serialised do not break the push', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const o = {}; o.self = o; dataLayer.push(o);`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([['[unserializable]']]);
  expect(page.run('dataLayer.length')).toBe(1);
});

test('turns payloads into records on the shared clock', async () => {
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

test('a payload from an embedded frame keeps its frame number and main false', async () => {
  const runId = newId('run');
  const payload = { t: 1, args: '[{"event":"x"}]' };
  const first = dataLayerEventFromPayload(payload, runId, 0, { main: false, n: 3 });
  const second = dataLayerEventFromPayload(payload, runId, 0, { main: false, n: 3 });
  expect(first?.frame).toEqual({ main: false, n: 3 });
  expect(second?.frame).toEqual(first?.frame);
  expect(dataLayerEventFromPayload(payload, runId, 0, MAIN)?.frame).toEqual({ main: true, n: 0 });
});

test('malformed payloads are dropped', async () => {
  const runId = newId('run');
  expect(dataLayerEventFromPayload({ t: 1, args: 'nope' }, runId, 0, MAIN)).toBeUndefined();
  expect(dataLayerEventFromPayload({ t: 1, args: '{}' }, runId, 0, MAIN)).toBeUndefined();
});

test('a push over the size limit keeps its event name and drops the deep values', async () => {
  const page = pageWith('');
  page.run(
    `window.dataLayer = []; dataLayer.push({ event: 'purchase', 'gtm.uniqueEventId': 9, ecommerce: { value: 5, items: Array.from({ length: 400 }, (_, i) => ({ item_id: 'SKU' + i, item_name: 'Fake tee ' + i })) } });`,
  );
  await page.settle();
  expect(page.sent[0]!.args.length).toBeLessThanOrEqual(10000);
  await page.settle();
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
  await page.settle();
  const event = dataLayerEventFromPayload(page.sent[0]!, newId('run'), 0, MAIN);
  expect(event).toMatchObject({ isConsentCommand: true });
  expect((event?.args[2] as Record<string, unknown>).analytics_storage).toBe('granted');
});

test('a wrapper that calls the saved push reports each push once', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const saved = dataLayer.push; dataLayer.push = function () { return saved.apply(this, arguments); }; dataLayer.push({ event: 'a' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }]]);
  expect(page.run('dataLayer.length')).toBe(1);
});

test('two stacked call-through wrappers report once and reach the array', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = [];
    for (let i = 0; i < 2; i++) { const saved = dataLayer.push; dataLayer.push = function () { return saved.apply(this, arguments); }; }
    dataLayer.push({ event: 'a' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }]]);
  expect(page.run('dataLayer.length')).toBe(1);
});

test('a wrapper that drops a push records nothing, because the push never reached the array', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push = function () { return 0; }; dataLayer.push({ event: 'a' });`);
  await page.settle();
  expect(page.sent).toEqual([]);
});

test('assigning Array.prototype.push records pushes through the length change', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push = Array.prototype.push; dataLayer.push({ event: 'a' }, { event: 'b' }); dataLayer.push({ event: 'c' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }], [{ event: 'c' }]]);
});

test('a wrapper that calls Array.prototype.push records each push once', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push = function () { return Array.prototype.push.apply(this, arguments); }; dataLayer.push({ event: 'a' }); dataLayer.push({ event: 'b' });`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'b' }]]);
});

test('a wrapper that pushes a copy through the saved push records both items', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const saved = dataLayer.push;
    dataLayer.push = function (item) { saved.call(this, { ...item, copy: true }); return saved.apply(this, arguments); };
    dataLayer.push({ event: 'a' });`);
  await page.settle();
  expect(page.run('dataLayer.length')).toBe(2);
  expect(argsOf(page.sent)).toEqual([[{ event: 'a', copy: true }], [{ event: 'a' }]]);
});

test('push is the function the page assigned', () => {
  const page = pageWith('');
  expect(page.run(`window.dataLayer = []; const f = function () { return 0; }; dataLayer.push = f; dataLayer.push === f`)).toBe(true);
  expect(page.run(`window.dataLayer = []; const s = dataLayer.push; dataLayer.push = s; dataLayer.push === s`)).toBe(true);
});

test('an identity-guarded install runs the page wrapper once however often it runs', async () => {
  for (const times of [1, 3]) {
    const page = pageWith('');
    page.run(`window.dataLayer = []; globalThis.n = 0; let saved, mine;
      function install() { if (dataLayer.push === mine) return; saved = dataLayer.push;
        mine = function () { n++; return saved.apply(this, arguments); }; dataLayer.push = mine; }
      for (let i = 0; i < ${times}; i++) install(); dataLayer.push({ event: 'a' });`);
    await page.settle();
    expect(page.run('n')).toBe(1);
    expect(page.run('dataLayer.length')).toBe(1);
    expect(page.sent).toHaveLength(1);
  }
});

test('a fixed-function identity-guarded install does not throw or recurse', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.n = 0; let saved;
    const mine = function () { n++; return saved.apply(this, arguments); };
    function install() { if (dataLayer.push === mine) return; saved = dataLayer.push; dataLayer.push = mine; }
    install(); install(); install();`);
  expect(() => page.run(`dataLayer.push({ event: 'a' })`)).not.toThrow();
  await page.settle();
  expect(page.run('n')).toBe(1);
  expect(page.sent).toHaveLength(1);
});

test('a non-configurable or frozen push never throws into page code', async () => {
  const page = pageWith('');
  expect(() =>
    page.run(`window.dataLayer = [];
      const a = []; Object.defineProperty(a, 'push', { value: Array.prototype.push, configurable: false, writable: false });
      window.dataLayer = a; a.push({ event: 'a' });
      const b = Object.freeze([]); window.dataLayer = b; try { b.push({ event: 'b' }); } catch {}`),
  ).not.toThrow();
  const pre = pageWith(`const z = []; Object.defineProperty(z, 'push', { value: Array.prototype.push, configurable: false }); window.dataLayer = z;`);
  expect(() => pre.run(`dataLayer.push({ event: 'c' }); dataLayer.length`)).not.toThrow();
  await pre.settle();
  expect(argsOf(pre.sent)).toEqual([[{ event: 'c' }]]);
});

test('gtm.uniqueEventId is read after the push returns', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const saved = dataLayer.push;
    dataLayer.push = function (item) { const r = saved.apply(this, arguments); item['gtm.uniqueEventId'] = 42; return r; };
    dataLayer.push({ event: 'a' });`);
  await page.settle();
  expect(page.sent[0]?.uid).toBe(42);
  await page.settle();
  expect(JSON.parse(page.sent[0]!.args)).toEqual([{ event: 'a' }]);
});

test('the time is taken when the push reaches the array', async () => {
  const sent: Sent[] = [];
  let now = 5;
  const sandbox: Record<string, unknown> = {
    performance: { timeOrigin: 1000, now: () => now },
    Node: class {},
    queueMicrotask,
    tick: () => {
      now = 50;
    },
    [DATALAYER_BINDING]: (payload: Sent) => {
      sent.push(payload);
      return Promise.resolve();
    },
  };
  sandbox.window = sandbox;
  runInNewContext(dataLayerInitScript, sandbox);
  runInNewContext(`window.dataLayer = []; const saved = dataLayer.push; dataLayer.push = function () { tick(); return saved.apply(this, arguments); }; dataLayer.push({ event: 'a' });`, sandbox);
  await new Promise((r) => setTimeout(r, 5));
  expect(sent[0]?.t).toBe(1050);
});

test('replacing a hooked dataLayer reports a reassign, and assigning the same array does not', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; window.dataLayer = window.dataLayer || [];`);
  await page.settle();
  expect(page.sent.filter((s) => s.reassigned)).toEqual([]);
  page.run(`window.dataLayer = [];`);
  await page.settle();
  expect(page.sent.filter((s) => s.reassigned)).toHaveLength(1);
});

test('a reassign payload makes no record and a late id becomes the record id', async () => {
  const runId = newId('run');
  expect(dataLayerEventFromPayload({ t: 1, args: '[]', reassigned: true }, runId, 0, MAIN)).toBeUndefined();
  const event = dataLayerEventFromPayload({ t: 1, args: '[{"event":"a"}]', uid: 9 }, runId, 0, MAIN);
  expect(event?.gtmUniqueEventId).toBe(9);
});

test('a push made while a wrapper runs goes through the wrapper and is recorded once', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.calls = []; const saved = dataLayer.push;
    dataLayer.push = function () {
      const r = saved.apply(this, arguments);
      for (const item of arguments) { calls.push(item.event); if (item.event === 'a') dataLayer.push({ event: 'nested' }); }
      return r;
    };
    dataLayer.push({ event: 'a' });`);
  expect(page.run('calls')).toEqual(['a', 'nested']);
  expect(page.run('dataLayer.length')).toBe(2);
  await page.settle();
  expect(argsOf(page.sent).map((a) => ((a as Array<{ event: string }>)[0]!).event).sort()).toEqual(['a', 'nested']);
});

test('a deferred call to the saved push is not reported again and does not loop', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.n = 0; const saved = dataLayer.push;
    dataLayer.push = function () { n++; const args = arguments; Promise.resolve().then(() => saved.apply(this, args)); return 0; };
    dataLayer.push({ event: 'a' });`);
  await new Promise((r) => setTimeout(r, 10));
  expect(page.run('n')).toBe(1);
  expect(page.run('dataLayer.length')).toBe(1);
  await page.settle();
  expect(page.sent).toHaveLength(1);
});

test('putting the saved push back removes the wrapper', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.n = 0; const saved = dataLayer.push;
    dataLayer.push = function () { n++; return saved.apply(this, arguments); };
    dataLayer.push({ event: 'a' }); dataLayer.push = saved; dataLayer.push({ event: 'b' });`);
  expect(page.run('n')).toBe(1);
  expect(page.run('dataLayer.length')).toBe(2);
  await page.settle();
  expect(page.sent).toHaveLength(2);
});

test('a cached entry still runs its own wrapper after an out-of-order unwrap', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.log = [];
    const s0 = dataLayer.push;
    dataLayer.push = function () { log.push(1); return s0.apply(this, arguments); };
    const s1 = dataLayer.push;
    dataLayer.push = function () { log.push(2); return s1.apply(this, arguments); };
    globalThis.cached = dataLayer.push;
    dataLayer.push = s0;`);
  expect(() => page.run(`cached.call(dataLayer, { event: 'a' })`)).not.toThrow();
  expect(page.run('dataLayer.length')).toBe(1);
  expect(page.run('log')).toEqual([2, 1]);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }]]);
});

test('a saved call-through keeps its wrapper when a new wrapper is added after an unwrap', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.log = [];
    const s0 = dataLayer.push;
    dataLayer.push = function () { log.push(1); return s0.apply(this, arguments); };
    const s1 = dataLayer.push;
    dataLayer.push = function () { log.push(2); return s1.apply(this, arguments); };
    dataLayer.push = s0;
    const s2 = dataLayer.push;
    dataLayer.push = function () { log.push(3); return s2.apply(this, arguments); };
    s1.call(dataLayer, { event: 'a' });`);
  expect(page.run('log')).toEqual([1]);
});

test('a cached top entry assigned back after a restore is active again', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.n = 0;
    const s0 = dataLayer.push;
    dataLayer.push = function () { n++; return s0.apply(this, arguments); };
    globalThis.top = dataLayer.push;
    dataLayer.push = s0;
    dataLayer.push = top;
    dataLayer.push({ event: 'a' });`);
  expect(page.run('dataLayer.push === top')).toBe(true);
  expect(page.run('n')).toBe(1);
});

test('an extra item pushed through the saved push is recorded', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const s0 = dataLayer.push;
    dataLayer.push = function () { s0.call(this, { event: 'extra' }); return s0.apply(this, arguments); };
    dataLayer.push({ event: 'a' });`);
  expect(page.run('dataLayer.length')).toBe(2);
  await page.settle();
  expect(argsOf(page.sent).map((a) => ((a as Array<{ event: string }>)[0]!).event).sort()).toEqual(['a', 'extra']);
});

test('the same object pushed twice is reported twice', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; const o = { event: 'a' }; dataLayer.push(o); dataLayer.push(o);`);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'a' }]]);
});

test('the same object pushed twice through an Array.prototype.push wrapper is reported twice', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push = function () { return Array.prototype.push.apply(this, arguments); };
    const o = { event: 'a' }; dataLayer.push(o); dataLayer.push(o);`);
  expect(page.run('dataLayer.length')).toBe(2);
  await page.settle();
  expect(argsOf(page.sent)).toEqual([[{ event: 'a' }], [{ event: 'a' }]]);
});

test('a marker-guarded install runs the page wrapper once however often it is called', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; globalThis.n = 0;
    function install() { if (dataLayer.push.mine) return; const saved = dataLayer.push;
      const w = function () { n++; return saved.apply(this, arguments); }; w.mine = true; dataLayer.push = w; }
    install(); install(); install(); dataLayer.push({ event: 'a' });`);
  expect(page.run('n')).toBe(1);
  expect(page.run('dataLayer.length')).toBe(1);
  await page.settle();
  expect(page.sent).toHaveLength(1);
});

test('assigning a non-function to push is kept, as without the hook', async () => {
  const page = pageWith('');
  page.run(`window.dataLayer = []; dataLayer.push = undefined;`);
  expect(page.run('dataLayer.push')).toBeUndefined();
});
