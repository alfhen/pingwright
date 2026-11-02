import { newId, type ConsentEpoch, type Flag, type Hit, type Request, type RunRecords, type Step } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { diffRuns, diffShapes, hitShape, type ShapeKey, type ShapeTuple } from './diff.ts';

const state = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' } as const;
const consent = { ...state, raw: { gcs: 'G100' } };

function makeRun(version: number | null = 1): RunRecords {
  const runId = newId('run');
  return {
    run: {
      type: 'run', id: runId, recordSchemaVersion: version ?? undefined, scenario: 's', site: 'http://localhost:3000', startedAt: 0,
      pingwrightVersion: '0.2.0', browser: { name: 'chromium', version: '1' }, networkMode: 'stub', gtmOverride: null,
      containerVersions: {}, identity: null,
    },
    steps: [], requests: [], responses: [], hits: [], dataLayerEvents: [], tagReports: [],
    consentEpochs: [epoch(runId, 'undecided', 0)], checkpoints: [], results: [], flags: [], collectorReports: [], invalidReports: [],
  };
}

function epoch(runId: string, label: ConsentEpoch['label'], startT: number): ConsentEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId: runId as ConsentEpoch['runId'], startT, endT: null, source: 'test', label, state };
}

function addHit(run: RunRecords, over: Partial<Hit> = {}, host = 'www.google-analytics.com'): Hit {
  const req: Request = {
    type: 'request', id: newId('request'), runId: run.run.id, stepId: over.stepId ?? null, t: over.t ?? 0, method: 'GET',
    url: `https://${host}/g/collect`, resourceType: 'image', frameUrl: null, initiator: null, headers: {}, postData: null,
    outcome: 'stubbed',
  };
  const hit: Hit = {
    type: 'hit', id: newId('hit'), runId: run.run.id, stepId: null, requestId: req.id, t: 0, vendor: 'ga4',
    event: 'page_view', consent, ids: {}, page: 'http://localhost:3000/', transport: 'GET', params: {}, ...over,
  };
  run.requests.push(req);
  run.hits.push(hit);
  return hit;
}

function addFlag(run: RunRecords, hit: Hit, kind: string): void {
  const flag: Flag = { type: 'flag', id: newId('flag'), runId: run.run.id, kind, recordIds: [hit.requestId], detail: '' };
  run.flags.push(flag);
}

test('identical runs have no differences', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a);
  addHit(b);
  expect(diffRuns(a, b)).toEqual({ warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags: [] });
});

test('reports an added and a removed hit', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { vendor: 'meta', event: 'PageView' });
  addHit(b, { vendor: 'ga4', event: 'purchase' });
  const d = diffRuns(a, b);
  expect(d.removed.map((h) => h.key.vendor)).toEqual(['meta']);
  expect(d.added.map((h) => h.key.event)).toEqual(['purchase']);
  expect(d.changed).toEqual([]);
});

test('reports gcs, gcd and normalised consent changes on a paired hit', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { consent: { ...consent, raw: { gcs: 'G100', gcd: '13p3p3p3p5' } } });
  addHit(b, {
    consent: { ...consent, analytics: 'granted', raw: { gcs: 'G101', gcd: '13t3t3t3t5' } },
  });
  const [change] = diffRuns(a, b).changed;
  expect(change!.consent).toEqual([
    { field: 'analytics', a: 'denied', b: 'granted' },
    { field: 'gcs', a: 'G100', b: 'G101' },
    { field: 'gcd', a: '13p3p3p3p5', b: '13t3t3t3t5' },
  ]);
});

test('reports ID presence changes, including hashes', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { ids: { client_id: true, hashes: { em: { present: false, matchesIdentity: null } } } });
  addHit(b, { ids: { client_id: true, user_id: true, hashes: { em: { present: true, matchesIdentity: true } } } });
  const [change] = diffRuns(a, b).changed;
  expect(change!.ids).toEqual([
    { field: 'hashes.em', a: 'absent', b: 'present' },
    { field: 'user_id', a: 'absent', b: 'present' },
  ]);
});

test('reports a key whose counts differ and pairs in time order', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { t: 10 });
  addHit(b, { t: 5 });
  const late = addHit(b, { t: 20, ids: { user_id: true } });
  const d = diffRuns(a, b);
  expect(d.countMismatches).toEqual([{ key: expect.objectContaining({ vendor: 'ga4' }), a: 1, b: 2 }]);
  expect(d.added.map((h) => h.hitId)).toEqual([late.id]);
  expect(d.changed).toEqual([]);
});

function addStep(run: RunRecords, label: string, index = 0): Step {
  const s: Step = { type: 'step', id: newId('step'), runId: run.run.id, index, label, startedAt: 0, endedAt: null };
  run.steps.push(s);
  return s;
}

test('pairs a hit that lands in a different step in each run', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { stepId: addStep(a, 'start').id, t: 2000 });
  addHit(b, { stepId: addStep(b, 'consent-1').id, t: 4000 });
  const d = diffRuns(a, b);
  expect(d.added).toEqual([]);
  expect(d.removed).toEqual([]);
  expect(d.countMismatches).toEqual([]);
  expect(d.changed).toEqual([]);
});

test('a changed hit keeps the step of each side', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { stepId: addStep(a, 'start').id });
  addHit(b, { stepId: addStep(b, 'consent-1').id, consent: { ...consent, raw: { gcs: 'G111' } } });
  const d = diffRuns(a, b);
  expect(d.changed).toHaveLength(1);
  expect(d.changed[0]).toMatchObject({ a: { step: 'start' }, b: { step: 'consent-1' } });
  expect(d.changed[0]!.key).not.toHaveProperty('step');
});

test('pairs hits of a group by order, whatever their steps', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { t: 10 });
  addHit(a, { t: 20 });
  const sb = addStep(b, 'late');
  addHit(b, { t: 30, stepId: sb.id });
  addHit(b, { t: 40, stepId: sb.id });
  addHit(b, { t: 50, stepId: sb.id });
  const d = diffRuns(a, b);
  expect(d.added).toHaveLength(1);
  expect(d.added[0]!.t).toBe(50);
  expect(d.removed).toEqual([]);
});

test('a withdrawn epoch does not pair with a first reject', () => {
  const a = makeRun();
  a.consentEpochs.push(epoch(a.run.id, 'denied', 100));
  addHit(a, { t: 150 });
  const b = makeRun();
  b.consentEpochs.push(epoch(b.run.id, 'granted', 100), epoch(b.run.id, 'withdrawn', 200));
  addHit(b, { t: 250 });
  const d = diffRuns(a, b);
  expect(d.removed.map((h) => h.key.epoch)).toEqual(['denied']);
  expect(d.added.map((h) => h.key.epoch)).toEqual(['withdrawn']);
  expect(d.changed).toEqual([]);
});

test('byPage adds the page path to the key', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { page: 'http://localhost:3000/cart' });
  addHit(b, { page: 'http://localhost:3000/checkout' });
  expect(diffRuns(a, b).added).toEqual([]);
  const d = diffRuns(a, b, { byPage: true });
  expect(d.removed[0]!.key.page).toBe('/cart');
  expect(d.added[0]!.key.page).toBe('/checkout');
});

test('byPage strips the sandbox prefix from the key and keeps the raw page in the record', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { page: 'https://shop.example.com/web-pixels@aaa/custom/web-pixel-1@1/sandbox/modern/collections/yarn' });
  addHit(b, { page: 'https://shop.example.com/web-pixels@bbb/custom/web-pixel-1@2/sandbox/modern/collections/yarn' });
  addHit(b, { page: 'https://shop.example.com/collections/yarn' });
  const d = diffRuns(a, b, { byPage: true });
  expect(d.removed).toEqual([]);
  expect(d.added).toHaveLength(1);
  expect(d.countMismatches).toEqual([{ key: expect.objectContaining({ page: '/collections/yarn' }), a: 1, b: 2 }]);
  expect(a.hits[0]!.page).toContain('web-pixels@aaa');
});

test('byPage groups a hit without a page by its frame URL, else under an empty page', () => {
  const a = makeRun();
  const b = makeRun();
  addHit(a, { page: null });
  addHit(b, { page: null });
  const framed = addHit(b, { page: null });
  b.requests.find((r) => r.id === framed.requestId)!.frameUrl = 'http://localhost:3000/web-pixels@x/sandbox/modern/cart';
  const d = diffRuns(a, b, { byPage: true });
  expect(d.added.map((h) => h.key.page)).toEqual(['/cart']);
  expect(d.countMismatches.map((m) => m.key.page)).toEqual(['/cart']);
  expect(d.changed).toEqual([]);
});

test('reports flag changes per host and kind', () => {
  const a = makeRun();
  const b = makeRun();
  const ha = addHit(a, {}, 'tracker.example.com');
  addFlag(a, ha, 'unknownDestination');
  const hb = addHit(b, {}, 'tracker.example.com');
  addFlag(b, hb, 'unknownDestination');
  addFlag(b, hb, 'unknownDestination');
  addFlag(b, addHit(b, {}, 'other.example.com'), 'stubBypass');
  expect(diffRuns(a, b).flags).toEqual([
    { host: 'other.example.com', kind: 'stubBypass', a: 0, b: 1, allowed: false },
    { host: 'tracker.example.com', kind: 'unknownDestination', a: 1, b: 2, allowed: false },
  ]);
});

test('marks unknownDestination changes allowed when the built-in check did not block them', () => {
  const a = makeRun();
  const b = makeRun();
  addFlag(a, addHit(a, {}, 'ok.example.com'), 'unknownDestination');
  addFlag(b, addHit(b, {}, 'ok.example.com'), 'unknownDestination');
  addFlag(b, addHit(b, {}, 'ok.example.com'), 'unknownDestination');
  const blocked = b.flags[0]!;
  const result = (pass: boolean, evidence: string[]) =>
    ({ type: 'result', id: newId('result'), runId: b.run.id, expectation: 'builtin: unknownDestination', pass, evidence }) as RunRecords['results'][number];
  a.results.push({ ...result(true, [a.flags[0]!.id]), runId: a.run.id });
  b.results.push(result(true, b.flags.map((f) => f.id)));
  expect(diffRuns(a, b).flags).toEqual([{ host: 'ok.example.com', kind: 'unknownDestination', a: 1, b: 2, allowed: true }]);
  b.results[0] = result(false, [blocked.id]);
  expect(diffRuns(a, b).flags[0]?.allowed).toBe(false);
});

test('does not report a flag change when only the host port differs', () => {
  const a = makeRun();
  const b = makeRun();
  addFlag(a, addHit(a, {}, '127.0.0.1:41001'), 'unknownDestination');
  addFlag(b, addHit(b, {}, '127.0.0.1:41002'), 'unknownDestination');
  expect(diffRuns(a, b).flags).toEqual([]);
});

test('warns when record schema versions differ,treating a missing version as 0', () => {
  const d = diffRuns(makeRun(null), makeRun(1));
  expect(d.warnings).toHaveLength(1);
  expect(d.warnings[0]).toContain('0 and 1');
  expect(diffRuns(makeRun(1), makeRun(1)).warnings).toEqual([]);
});

const granted = { ...consent, analytics: 'granted' as const };
const shapeOf = (r: RunRecords, byPage = false) => hitShape(r, { byPage });

function pair(hitsA: Partial<Hit>[], hitsB: Partial<Hit>[]): [RunRecords, RunRecords] {
  const a = makeRun();
  const b = makeRun();
  for (const h of hitsA) addHit(a, h);
  for (const h of hitsB) addHit(b, h);
  return [a, b];
}

test('hitShape groups hits by key and tuple with a count, and holds no ID, time or URL', () => {
  const run = makeRun();
  addHit(run, { t: 5, ids: { client_id: true, user_id: false } });
  addHit(run, { t: 6, ids: { client_id: true } });
  addHit(run, { t: 7, consent: granted });
  const [shape] = shapeOf(run);
  expect(shape!.key).toEqual({ epoch: 'undecided', vendor: 'ga4', event: 'page_view' });
  expect(shape!.tuples).toHaveLength(2);
  expect(shape!.tuples.map((t) => t.count).sort()).toEqual([1, 2]);
  expect(shape!.tuples.find((t) => t.count === 2)).toMatchObject({ ids: ['client_id'], consent: { analytics: 'denied', gcs: 'G100', gcd: '' } });
  const text = JSON.stringify(shape);
  for (const leak of ['hit_', 'req_', 'localhost']) expect(text).not.toContain(leak);
});

test('diffShapes finds no drift in the same run', () => {
  const [a, b] = pair([{}, { vendor: 'meta', event: 'PageView' }], [{}, { vendor: 'meta', event: 'PageView' }]);
  expect(diffShapes(shapeOf(a), shapeOf(b))).toEqual({ added: [], removed: [], countChanges: [], moved: [], drift: false });
});

test('a key on one side only is drift, and is also added or removed in diffRuns', () => {
  const [a, b] = pair([{}], [{}, { event: 'add_to_cart' }]);
  const d = diffShapes(shapeOf(a), shapeOf(b));
  expect(d.drift).toBe(true);
  expect(d.added).toMatchObject([{ key: { event: 'add_to_cart' }, wholeKey: true }]);
  expect(diffRuns(a, b).added.map((h) => h.key.event)).toEqual(['add_to_cart']);
  expect(diffShapes(shapeOf(b), shapeOf(a)).removed).toMatchObject([{ key: { event: 'add_to_cart' }, wholeKey: true }]);
});

test('a consent change is one tuple removed and one added', () => {
  const [a, b] = pair([{}], [{ consent: granted }]);
  const d = diffShapes(shapeOf(a), shapeOf(b));
  expect(d.drift).toBe(true);
  expect(d.removed).toHaveLength(1);
  expect(d.added).toHaveLength(1);
  expect(d.added[0]!.wholeKey).toBe(false);
});

test('a change in raw gcs, or in ID presence, is drift', () => {
  const [a, b] = pair([{}], [{ consent: { ...consent, raw: { gcs: 'G111' } } }]);
  expect(diffShapes(shapeOf(a), shapeOf(b)).drift).toBe(true);
  const [c, d] = pair([{ ids: { client_id: true } }], [{ ids: {} }]);
  expect(diffShapes(shapeOf(c), shapeOf(d)).drift).toBe(true);
});

test('a count-only change is listed and is not drift', () => {
  const [a, b] = pair([{}], [{}, {}, {}]);
  const d = diffShapes(shapeOf(a), shapeOf(b));
  expect(d.drift).toBe(false);
  expect(d.countChanges).toMatchObject([{ a: 1, b: 3 }]);
  expect(diffRuns(a, b).countMismatches).toHaveLength(1);
});

test('a new tuple inside a key on both sides is drift, although diffRuns shows a count mismatch and one added hit', () => {
  const [a, b] = pair([{ t: 1 }], [{ t: 1 }, { t: 2, consent: granted }]);
  const shape = diffShapes(shapeOf(a), shapeOf(b));
  expect(shape.drift).toBe(true);
  expect(shape.added).toMatchObject([{ wholeKey: false }]);
  const runs = diffRuns(a, b);
  expect(runs.countMismatches).toHaveLength(1);
  expect(runs.added).toHaveLength(1);
  expect(runs.changed).toEqual([]);
});

test('reordered tuples in a key are changed in diffRuns and are not drift', () => {
  const [a, b] = pair([{ t: 1 }, { t: 2, consent: granted }], [{ t: 1, consent: granted }, { t: 2 }]);
  expect(diffRuns(a, b).changed).toHaveLength(2);
  expect(diffShapes(shapeOf(a), shapeOf(b)).drift).toBe(false);
});

test('byPage adds the page path to the shape key', () => {
  const [a, b] = pair([{ page: 'http://localhost/a' }], [{ page: 'http://localhost/b' }]);
  expect(shapeOf(a, true)[0]!.key.page).toBe('/a');
  expect(diffShapes(shapeOf(a, true), shapeOf(b, true)).drift).toBe(true);
  expect(diffShapes(shapeOf(a), shapeOf(b)).drift).toBe(false);
});

const tuple = (count: number, over: Partial<ShapeTuple> = {}): ShapeTuple => ({ consent: { analytics: 'denied', gcs: 'G100' }, ids: [], count, ...over });
const shapeKey = (epoch: string, tuples: ShapeTuple[], vendor = 'meta'): ShapeKey => ({ key: { epoch, vendor, event: 'PageView' }, tuples });
const order = { epochOrder: ['undecided', 'granted', 'denied'] };

test('a sorted copy of the keys and consent fields gives no drift', () => {
  const a = [shapeKey('undecided', [tuple(1)])];
  const sorted: ShapeKey[] = [{ key: { vendor: 'meta', event: 'PageView', epoch: 'undecided' } as ShapeKey['key'], tuples: [{ ids: [], count: 1, consent: { gcs: 'G100', analytics: 'denied' } }] }];
  expect(diffShapes(a, sorted)).toMatchObject({ drift: false, added: [], removed: [], countChanges: [] });
});

test('a whole key that moves across one consent answer is a move, in both directions', () => {
  const early = [shapeKey('undecided', [tuple(1)])];
  const late = [shapeKey('granted', [tuple(1, { consent: { analytics: 'granted', gcs: 'G111' } })])];
  expect(diffShapes(early, late, order)).toMatchObject({ drift: false, added: [], removed: [], moved: [{ vendor: 'meta', event: 'PageView', from: 'undecided', to: 'granted', count: 1 }] });
  expect(diffShapes(late, early, order)).toMatchObject({ drift: false, moved: [{ from: 'granted', to: 'undecided' }] });
  expect(diffShapes(early, late).drift).toBe(true);
});

test('a partial move is a move', () => {
  const granted = tuple(1, { consent: { analytics: 'granted', gcs: 'G111' } });
  const a = [shapeKey('undecided', [tuple(1)]), shapeKey('granted', [granted])];
  const b = [shapeKey('granted', [{ ...granted, count: 2 }])];
  expect(diffShapes(a, b, order)).toMatchObject({ drift: false, moved: [{ from: 'undecided', to: 'granted', count: 1 }] });
});

test('a move across two answers, a changed total, or a hit that did not stay is drift', () => {
  const t = tuple(1);
  expect(diffShapes([shapeKey('undecided', [t])], [shapeKey('denied', [t])], order).drift).toBe(true);
  expect(diffShapes([shapeKey('undecided', [t]), shapeKey('granted', [t])], [shapeKey('granted', [t])], order).drift).toBe(true);
  const other = tuple(1, { ids: ['client_id'] });
  expect(diffShapes([shapeKey('undecided', [t, t])], [shapeKey('undecided', [other]), shapeKey('granted', [t])], order).drift).toBe(true);
  expect(diffShapes([shapeKey('undecided', [t])], [shapeKey('granted', [t])], { epochOrder: ['undecided', 'granted', 'undecided'] }).drift).toBe(true);
});

test('another vendor in the same epochs is compared as before', () => {
  const a = [shapeKey('undecided', [tuple(1)]), shapeKey('undecided', [tuple(1)], 'ga4')];
  const b = [shapeKey('granted', [tuple(1)]), shapeKey('undecided', [tuple(1)], 'ga4')];
  expect(diffShapes(a, b, order)).toMatchObject({ drift: false, moved: [{ vendor: 'meta' }] });
});
