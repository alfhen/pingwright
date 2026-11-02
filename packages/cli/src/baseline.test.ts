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
