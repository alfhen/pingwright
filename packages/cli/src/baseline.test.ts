import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, type Hit, type RunRecords } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { parseCli, UsageError } from './args.ts';
import { buildBaseline, compareBaseline, parseBaseline } from './baseline.ts';
import { main } from './main.ts';
import { formatSummary, type Summary } from './summary.ts';

const state = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' } as const;

function makeRun(events: string[], site = 'http://localhost:3000'): RunRecords {
  const runId = newId('run');
  const hits = events.map((event, i): Hit => ({
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: newId('request'), t: i, vendor: 'ga4', event,
    consent: { ...state, raw: { gcs: 'G100' } }, ids: { client_id: true }, page: `${site}/p?em=pw-fixture@example.com`, transport: 'GET', params: { em: 'pw-fixture@example.com' },
  }));
  return {
    run: {
      type: 'run', id: runId, recordSchemaVersion: 1, scenario: 's.yml', site, startedAt: 0, pingwrightVersion: '0.4.0',
      browser: { name: 'chromium', version: '1' }, networkMode: 'stub', gtmOverride: null, containerVersions: {}, identity: null,
    },
    steps: [], requests: [], responses: [], hits, dataLayerEvents: [], tagReports: [],
    consentEpochs: [{ type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: 0, endT: null, source: 'test', label: 'undecided', state }],
    checkpoints: [], results: [], flags: [], collectorReports: [], invalidReports: [],
  } as unknown as RunRecords;
}

test('a baseline holds the host only and no value, URL or ID', () => {
  const text = JSON.stringify(buildBaseline(makeRun(['page_view', 'page_view']), true));
  expect(JSON.parse(text)).toMatchObject({ baselineSchemaVersion: 1, scenario: 's.yml', site: 'localhost', byPage: true });
  for (const leak of ['pw-fixture', 'hit_', 'http://', '3000']) expect(text).not.toContain(leak);
});

test('a --by-page baseline holds no token from the page path', () => {
  const token = 'Z2NwLXVzLWVhc3QxOjAxSFBXVEVTVDAwMDAwMDAx';
  const run = makeRun(['page_view']);
  run.hits[0]!.page = `http://localhost:3000/checkouts/cn/${token}`;
  expect(JSON.stringify(run.hits)).toContain(token);
  const text = JSON.stringify(buildBaseline(run, true));
  expect(text).not.toContain(token);
  expect(text).toContain('/checkouts/cn/*');
});

test('compareBaseline reports added keys as drift and counts as no drift', () => {
  const baseline = buildBaseline(makeRun(['page_view']), false);
  expect(compareBaseline(baseline, makeRun(['page_view'])).drift).toBe(false);
  const counted = compareBaseline(baseline, makeRun(['page_view', 'page_view']));
  expect(counted).toMatchObject({ drift: false, countChanges: 1 });
  const added = compareBaseline(baseline, makeRun(['page_view', 'add_to_cart']));
  expect(added).toMatchObject({ drift: true, added: 1, removed: 0 });
  expect(added.changes[0]).toContain('ga4 add_to_cart');
});

test('a different scenario or site is a warning and the compare goes on', () => {
  const baseline = buildBaseline(makeRun(['page_view']), false);
  const other = makeRun(['page_view'], 'http://example.com');
  other.run.scenario = 'other.yml';
  const result = compareBaseline(baseline, other);
  expect(result.drift).toBe(false);
  expect(result.warnings).toHaveLength(2);
});

test('parseBaseline rejects bad files without quoting them', () => {
  const secret = 'pw-secret-value';
  expect(() => parseBaseline('{nope', 'b.json')).toThrow('b.json is not valid JSON');
  expect(() => parseBaseline(JSON.stringify({ x: secret }), 'b.json')).toThrow('not a baseline file');
  expect(() => parseBaseline(JSON.stringify({ baselineSchemaVersion: 2 }), 'b.json')).toThrow('baselineSchemaVersion 2');
  const bad = JSON.stringify({ baselineSchemaVersion: 1, scenario: secret, site: 'h', byPage: false, keys: [{ key: {}, tuples: [] }] });
  try {
    parseBaseline(bad, 'b.json');
    expect.unreachable();
  } catch (error) {
    expect((error as Error).message).not.toContain(secret);
  }
});

test('the summary shows the Baseline block and a failing result on drift', () => {
  const summary: Summary = {
    runId: 'r', path: 'p', pass: true, ok: false, hits: {}, epochs: [], flags: [], results: [],
    baseline: { drift: true, added: 1, removed: 0, countChanges: 0, warnings: [], changes: ['added ga4 add_to_cart [epoch undecided]'] },
  };
  const text = formatSummary(summary);
  expect(text).toContain('Baseline: drift (1 added, 0 removed, 0 count changes)');
  expect(text).toContain('added ga4 add_to_cart');
  expect(text).toContain('Result: fail (baseline drift)');
});

test('parses baseline save and run --baseline', () => {
  expect(parseCli(['baseline', 'save', 'r.jsonl', 'b.json', '--by-page'])).toEqual({ command: 'baseline', input: 'r.jsonl', output: 'b.json', byPage: true });
  expect(() => parseCli(['baseline', 'r.jsonl', 'b.json'])).toThrow(UsageError);
  expect(() => parseCli(['baseline', 'save', 'r.jsonl'])).toThrow(UsageError);
  expect(parseCli(['run', 's.yml', '--site', 'http://localhost:1', '--baseline', 'b.json'])).toMatchObject({ baseline: 'b.json' });
  expect(() => parseCli(['suite', 'd', '--site', 'http://localhost:1', '--baseline', 'b.json'])).toThrow(UsageError);
});

test('run exits 2 for a missing or invalid baseline before the browser launches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-baseline-'));
  const scenario = join(dir, 's.yml');
  await writeFile(scenario, 'start: /\nsteps: []\n');
  const bad = join(dir, 'bad.json');
  await writeFile(bad, '{"baselineSchemaVersion": 1, "x": "pw-secret-value"}');
  for (const file of [join(dir, 'missing.json'), bad]) {
    const err: string[] = [];
    const code = await main(['run', scenario, '--site', 'http://localhost:1', '--baseline', file], { stdout: () => {}, stderr: (t) => err.push(t) });
    expect(code).toBe(2);
    expect(err.join('')).not.toContain('pw-secret-value');
    expect(err.join('')).toContain(file);
  }
});

test('baseline save writes a sorted file and exits 2 for a missing run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-baseline-'));
  const err: string[] = [];
  expect(await main(['baseline', 'save', join(dir, 'none.jsonl'), join(dir, 'b.json')], { stdout: () => {}, stderr: (t) => err.push(t) })).toBe(2);
  expect(err.join('')).toContain('none.jsonl');
  const run = makeRun(['b_event', 'a_event']);
  const path = join(dir, 'run.jsonl');
  await writeFile(path, [run.run, ...run.consentEpochs, ...run.hits].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out: string[] = [];
  expect(await main(['baseline', 'save', path, join(dir, 'b.json')], { stdout: (t) => out.push(t), stderr: () => {} })).toBe(0);
  const file = JSON.parse(await readFile(join(dir, 'b.json'), 'utf8')) as { keys: { key: { event: string } }[] };
  expect(file.keys.map((k) => k.key.event)).toEqual(['a_event', 'b_event']);
  expect(out.join('')).toContain('2 keys, 2 hits');
});

function runWithEpochs(hits: Array<{ t: number }>, labels: string[]): RunRecords {
  const run = makeRun([]);
  run.consentEpochs = labels.map((label, i) => ({ ...run.consentEpochs[0]!, id: newId('consentEpoch'), startT: i * 100, label })) as RunRecords['consentEpochs'];
  const template = makeRun(['x']).hits[0]!;
  run.hits = hits.map((h): Hit => ({ ...template, id: newId('hit'), runId: run.run.id, t: h.t, vendor: 'meta', event: 'PageView' }));
  return run;
}

test('the scenario names compare without .yml or .yaml', () => {
  const baseline = buildBaseline(makeRun(['page_view']), false);
  for (const name of ['s', 's.yaml']) {
    const run = makeRun(['page_view']);
    run.run.scenario = name;
    expect(compareBaseline(baseline, run).warnings).toEqual([]);
  }
  const other = makeRun(['page_view']);
  other.run.scenario = 'other';
  expect(compareBaseline(baseline, other).warnings).toHaveLength(1);
});

test('two tuples with the same count change are two count changes', () => {
  const shaped = (n: number) => {
    const run = makeRun(Array.from({ length: n * 2 }, () => 'a'));
    run.hits.forEach((h, i) => { if (i % 2) h.ids = {}; });
    return run;
  };
  const result = compareBaseline(buildBaseline(shaped(1), false), shaped(2));
  expect(result).toMatchObject({ drift: false, countChanges: 2 });
  expect(result.changes).toHaveLength(2);
  const added = compareBaseline(buildBaseline(makeRun([]), false), makeRun(['a', 'b']));
  expect(added.added).toBe(2);
});

test('two tuples of one new key are two added tuples', () => {
  const run = makeRun(['a', 'a']);
  run.hits[1]!.ids = {};
  const result = compareBaseline(buildBaseline(makeRun([]), false), run);
  expect(result.added).toBe(2);
  expect(result.changes).toHaveLength(2);
});

test('a baseline with sorted keys compares the same', () => {
  const baseline = buildBaseline(makeRun(['page_view']), false);
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, sort(x)])) : v;
  const sorted = sort(baseline) as typeof baseline;
  expect(Object.keys(sorted)).not.toEqual(Object.keys(baseline));
  expect(compareBaseline(sorted, makeRun(['page_view']))).toMatchObject({ drift: false, added: 0, removed: 0, countChanges: 0 });
});

test('a hit that moved across one consent answer is a warning and no drift', () => {
  const labels = ['undecided', 'granted'];
  const result = compareBaseline(buildBaseline(runWithEpochs([{ t: 10 }], labels), false), runWithEpochs([{ t: 150 }], labels));
  expect(result).toMatchObject({ drift: false, added: 0, removed: 0 });
  expect(result.warnings).toEqual(['moved meta PageView from undecided to granted. This is not drift.']);
  const back = compareBaseline(buildBaseline(runWithEpochs([{ t: 150 }], labels), false), runWithEpochs([{ t: 10 }], labels));
  expect(back.drift).toBe(false);
  expect(back.warnings[0]).toContain('from granted to undecided');
  expect(back.warnings[0]).toContain('before the consent answer');
});

test('a changed total or a move across two answers is drift', () => {
  const labels = ['undecided', 'granted', 'denied'];
  const base = buildBaseline(runWithEpochs([{ t: 10 }, { t: 150 }], labels), false);
  expect(compareBaseline(base, runWithEpochs([{ t: 150 }], labels)).drift).toBe(true);
  const skip = compareBaseline(buildBaseline(runWithEpochs([{ t: 10 }], labels), false), runWithEpochs([{ t: 250 }], labels));
  expect(skip.drift).toBe(true);
  expect(skip.warnings).toEqual([]);
});

test('a baseline does not drift when only the time of a linked server hit changes within its via epoch', () => {
  const labels = ['undecided', 'granted', 'denied', 'undecided'];
  const withServer = (serverT: number): RunRecords => {
    const run = runWithEpochs([{ t: 150 }], labels);
    const pixel = run.hits[0]!;
    const request = { type: 'request', id: newId('request'), runId: run.run.id, captured: 'serverContainer' } as unknown as RunRecords['requests'][number];
    run.requests = [request];
    run.hits.push({ ...pixel, id: newId('hit'), requestId: request.id, vendor: 'meta-capi', t: serverT, via: { hitId: pixel.id, by: 'eventId', confidence: 'exact' } });
    return run;
  };
  expect(withServer(350).consentEpochs.find((e) => e.startT === 300)!.label).toBe('undecided');
  const result = compareBaseline(buildBaseline(withServer(160), false), withServer(350));
  expect(result).toMatchObject({ drift: false, added: 0, removed: 0, countChanges: 0 });
  expect(result.warnings).toEqual([]);
});
