import { newId, RunWriter, type ConsentState, type Hit, type PingwrightRecord, type RunRecords } from '@pingwright/core';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { main } from '../main.ts';
import type { SuiteManifest } from '../suite.ts';
import { buildReportModel } from './model.ts';
import { CSP, renderReport } from './render.ts';
import { buildSuiteModel, recordKey, renderSuiteReport, type SuiteRecords } from './suite.ts';

const EMAIL = 'pw-fixture@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');
const COOKIE = 'pwfake-cookie-value-0001';
const DENIED: ConsentState = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' };

function records(scenario: string, variant: string, events: string[], extra: Partial<RunRecords> = {}): RunRecords {
  const runId = newId('run');
  const hits: Hit[] = events.map((event, i) => ({
    type: 'hit',
    id: newId('hit'),
    runId,
    stepId: null,
    requestId: newId('request'),
    t: 1500 + i,
    vendor: 'ga4',
    event,
    consent: { ...DENIED, raw: { secret: COOKIE } },
    ids: { hashes: { em: { present: true, matchesIdentity: true } } },
    page: `https://shop.example.com/?email=${EMAIL}`,
    transport: 'image',
    params: { em: HASH },
    fields: [],
    fieldsComplete: true,
    idFields: [],
  }));
  return {
    run: {
      type: 'run',
      id: runId,
      recordSchemaVersion: 2,
      scenario,
      variant,
      site: `https://shop.example.com/products/${EMAIL}`,
      startedAt: 1_800_000_000_000,
      pingwrightVersion: '0.3.0',
      browser: { name: 'chromium', version: '156' },
      networkMode: 'stub',
      gtmOverride: null,
      containerVersions: {},
      identity: null,
    },
    steps: [],
    requests: [],
    responses: [],
    hits,
    dataLayerEvents: [],
    tagReports: [],
    consentEpochs: [{ type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: 0, endT: null, source: 'test', label: 'denied', state: DENIED }],
    checkpoints: [],
    results: [],
    flags: [],
    collectorReports: [],
    invalidReports: [],
    ...extra,
  };
}

const manifest: SuiteManifest = {
  suiteSchemaVersion: 1,
  id: 'suite_<b>01</b>',
  startedAt: 1_800_000_000_000,
  site: 'https://shop.example.com',
  variants: ['published', 'workspace'],
  cells: [
    { scenario: 'checkout', variant: 'published', labels: {}, status: 'pass', exitCode: 0, record: 'checkout.published.jsonl' },
    { scenario: 'checkout', variant: 'workspace', labels: {}, status: 'fail', exitCode: 1, record: 'checkout.workspace.jsonl' },
    { scenario: 'gone', variant: 'published', labels: {}, status: 'pass', exitCode: 0, record: 'gone.published.jsonl' },
    { scenario: 'gone', variant: 'workspace', labels: {}, status: 'error', exitCode: 2 },
  ],
  diffs: [],
  exitCode: 2,
};

const loaded: SuiteRecords = new Map([
  [recordKey('checkout', 'published'), records('checkout', 'published', ['page_view'])],
  [recordKey('checkout', 'workspace'), records('checkout', 'workspace', ['page_view', 'workspace_only'])],
]);

test('the model has a section per scenario and a diff per variant pair', () => {
  const model = buildSuiteModel(manifest, loaded);
  expect(model.header).toMatchObject({ host: 'shop.example.com', variants: ['published', 'workspace'], exitCode: 2 });
  expect(model.scenarios.map((s) => s.name)).toEqual(['checkout', 'gone']);
  expect(model.scenarios[0]!.cells.map((c) => c.model?.header.variant)).toEqual(['published', 'workspace']);
  expect(model.diffs).toHaveLength(1);
  expect(model.diffs[0]).toMatchObject({ scenario: 'checkout', from: 'published', to: 'workspace' });
  expect(model.diffs[0]!.rows).toEqual([{ epoch: 'denied', vendor: 'ga4', event: 'workspace_only', added: 1, removed: 0, changed: 0, countMismatches: 1 }]);
});

test('a manifest that points at a missing record is a warning, not a crash', () => {
  const model = buildSuiteModel(manifest, loaded);
  expect(model.warnings).toEqual(['gone (published): no record, so the run is not in this report', 'gone (workspace): no record, so the run is not in this report']);
  const html = renderSuiteReport(model);
  expect(html).toContain('Warning: gone (published): no record');
  expect(html).toContain('No record to show.');
});

test('a skipped cell is not a warning', () => {
  const skipped: SuiteManifest = { ...manifest, cells: manifest.cells.map((c) => (c.scenario === 'gone' ? { ...c, status: 'skipped' as const, exitCode: 0 as const } : c)) };
  expect(buildSuiteModel(skipped, loaded).warnings).toEqual([]);
});

test('the page lists both variants, the added event, and escapes the manifest', () => {
  const html = renderSuiteReport(buildSuiteModel(manifest, loaded));
  expect(html).toContain('<th scope="col">published</th><th scope="col">workspace</th>');
  expect(html).toMatch(/<tr><td>denied<\/td><td>ga4<\/td><td>workspace_only<\/td><td>1<\/td>/);
  expect(html).toContain('Exit code</dt><dd>2');
  expect(html).toContain('suite_&lt;b&gt;01&lt;/b&gt;');
  expect(html).not.toContain('<b>');
  expect(html).toContain('<h2>checkout</h2>');
  expect(html).toContain('Timeline per vendor');
});

test('the suite page holds no value and makes no request', () => {
  const html = renderSuiteReport(buildSuiteModel(manifest, loaded));
  for (const secret of [EMAIL, HASH, COOKIE, '/products/']) expect(html).not.toContain(secret);
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  expect(html).not.toMatch(/<script|<link|<img|@import|url\(/i);
  const tags = (html.match(/<[^>]*>/g) ?? []).join('\n');
  expect(tags).not.toMatch(/https?:|\b(?:src|href|action)=|\son\w+=/i);
});

function leaking(scenario: string, variant: string): RunRecords {
  const base = records(scenario, variant, ['page_view']);
  const results: RunRecords['results'] = [
    { type: 'result', id: newId('result'), runId: base.run.id, expectation: 'mustNot: {"vendor":"ga4","in":"epoch(denied)","params":{"em":"x"}}', pass: false, evidence: [base.hits[0]!.id], message: `${EMAIL} ${HASH}` },
    { type: 'result', id: newId('result'), runId: base.run.id, expectation: 'builtin: sandboxPageUrl', pass: false, evidence: [], severity: 'warn', message: COOKIE },
  ];
  return { ...base, results };
}

const mixedManifest: SuiteManifest = {
  ...manifest,
  cells: [
    { scenario: 'checkout', variant: 'published', labels: {}, status: 'fail', exitCode: 1, failed: { rules: 5, checks: ['deniedIdentifiers'] }, record: 'checkout.published.jsonl' },
    { scenario: 'checkout', variant: 'workspace', labels: {}, status: 'warn', exitCode: 0, failed: { rules: 0, checks: ['sandboxPageUrl'] }, record: 'checkout.workspace.jsonl' },
    { scenario: 'gone', variant: 'published', labels: {}, status: 'pass', exitCode: 0 },
    { scenario: 'gone', variant: 'workspace', labels: {}, status: 'error', exitCode: 2 },
  ],
};
const leakRecords: SuiteRecords = new Map([
  [recordKey('checkout', 'published'), leaking('checkout', 'published')],
  [recordKey('checkout', 'workspace'), records('checkout', 'workspace', ['page_view'], { results: [leaking('x', 'y').results[1]!] })],
]);

function headingPositions(html: string): number[] {
  return ['<h2>Verdict</h2>', '<h2>Results</h2>', 'Timeline per vendor', '<h2>Diff per variant pair</h2>'].map((h) => html.indexOf(h));
}

test('the page order is verdict, results, timelines, diff tables', () => {
  const positions = headingPositions(renderSuiteReport(buildSuiteModel(manifest, loaded)));
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
});

test('the verdict names vendors, states and counts per variant, and holds no value', () => {
  const html = renderSuiteReport(buildSuiteModel(mixedManifest, leakRecords));
  expect(html).toContain('<li><strong>published:</strong> ga4 send hits in the denied state, 1 failed expectation, 1 accepted warning</li>');
  expect(html).toContain('<li><strong>workspace:</strong> no leaks, 1 accepted warning, 1 run did not finish</li>');
  for (const secret of [EMAIL, HASH, COOKIE]) expect(html).not.toContain(secret);
});

test('a suite cell in the report names the failed rules and checks', () => {
  const html = renderSuiteReport(buildSuiteModel(mixedManifest, leakRecords));
  expect(html).toContain('<td>FAIL: 5 rules, deniedIdentifiers</td><td>WARN: sandboxPageUrl</td>');
  expect(html).toContain('<td>ERROR (exit 2)</td>');
  expect(html).not.toContain('FAIL (exit 1)');
});

test('a single-run report has the verdict line before the timeline', () => {
  const leak = renderReport(buildReportModel(leaking('checkout', 'published')));
  expect(leak).toContain('<p class="verdict">Verdict: ga4 send hits in the denied state, 1 failed expectation, 1 accepted warning.</p>');
  expect(leak.indexOf('class="verdict"')).toBeLessThan(leak.indexOf('Timeline per vendor'));
  const clean = renderReport(buildReportModel(records('checkout', 'published', ['page_view'])));
  expect(clean).toContain('<p class="verdict">Verdict: no leaks.</p>');
});

test('a run whose only failure could not be evaluated does not read as clean', () => {
  const base = records('checkout', 'published', ['page_view']);
  const result = { type: 'result' as const, id: newId('result'), runId: base.run.id, expectation: 'builtin: deniedIdentifiers', pass: false, evidence: [], note: 'cannotEvaluateBody' as const, message: COOKIE };
  const html = renderReport(buildReportModel({ ...base, results: [result] }));
  expect(html).toContain('<p class="verdict">Verdict: 1 expectation could not be checked.</p>');
  expect(html).not.toContain('no leaks');
  expect(html).not.toContain(COOKIE);
});

test('a flag with no host has no placeholder in the diff table', () => {
  const html = renderSuiteReport({
    header: { id: 's', startedAt: 'x', host: 'h', variants: ['a', 'b'], exitCode: 0 },
    warnings: [],
    scenarios: [],
    diffs: [{ scenario: 'c', from: 'a', to: 'b', warnings: [], rows: [], flags: [{ kind: 'unloadGap', host: '', a: 0, b: 1 }] }],
  });
  expect(html).toContain('flag unloadGap: 0 -&gt; 1');
  expect(html).not.toContain('no host');
});

test('a suite with one variant has no diff and says so', () => {
  const one: SuiteManifest = { ...manifest, variants: ['published'], cells: manifest.cells.filter((c) => c.variant === 'published') };
  const model = buildSuiteModel(one, loaded);
  expect(model.diffs).toEqual([]);
  expect(renderSuiteReport(model)).toContain('No variant pair has two records to compare.');
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-suite-report-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = () => {
  const err: string[] = [];
  return { err, io: { stdout: () => undefined, stderr: (t: string) => void err.push(t) } };
};

async function writeRecord(data: RunRecords, name: string): Promise<void> {
  const writer = await RunWriter.create(dir, data.run);
  const { run, truncatedAtLine, ...rest } = data;
  void run;
  void truncatedAtLine;
  for (const record of Object.values(rest).flat() as PingwrightRecord[]) await writer.append(record);
  await writer.close();
  const { rename } = await import('node:fs/promises');
  await rename(writer.path, join(dir, name));
}

test('report on a suite directory writes the page and survives a missing and an unreadable record', async () => {
  await writeRecord(loaded.get(recordKey('checkout', 'published'))!, 'checkout.published.jsonl');
  await writeRecord(loaded.get(recordKey('checkout', 'workspace'))!, 'checkout.workspace.jsonl');
  await writeFile(join(dir, 'gone.published.jsonl'), '{"type":"hit"}\n');
  await writeFile(join(dir, 'suite.json'), JSON.stringify(manifest));
  const out = join(dir, 'out', 'suite.html');
  const capture = io();
  expect(await main(['report', dir, '--html', out], capture.io)).toBe(0);
  const html = await readFile(out, 'utf8');
  expect(html).toContain('workspace_only');
  expect(html).toContain('Warning: gone (published)');
});

test('a record name that is a path is not read', async () => {
  await writeFile(join(dir, 'suite.json'), JSON.stringify({ ...manifest, cells: manifest.cells.map((c) => ({ ...c, record: `../${c.record ?? 'x'}` })) }));
  const out = join(dir, 'traversal.html');
  expect(await main(['report', dir, '--html', out], io().io)).toBe(0);
  expect(await readFile(out, 'utf8')).toContain('Warning: checkout (published): no record');
});

test('a directory with no manifest and a manifest that is not one exit 2', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'pw-suite-empty-'));
  try {
    expect(await main(['report', empty, '--html', join(dir, 'a.html')], io().io)).toBe(2);
    await writeFile(join(empty, 'suite.json'), '{"suiteSchemaVersion":2}');
    const capture = io();
    expect(await main(['report', empty, '--html', join(dir, 'a.html')], capture.io)).toBe(2);
    expect(capture.err.join('')).toContain('not a suite manifest');
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('a truncated record puts its line number on the page', () => {
  const cut = new Map(loaded);
  cut.set(recordKey('checkout', 'published'), { ...loaded.get(recordKey('checkout', 'published'))!, truncatedAtLine: 7 });
  const model = buildSuiteModel(manifest, cut);
  expect(model.warnings).toContain('checkout (published): record is truncated at line 7, so later records are missing from this report');
  expect(renderSuiteReport(model)).toContain('Warning: checkout (published): record is truncated at line 7');
});

test('each run section shows the run header', () => {
  const html = renderSuiteReport(buildSuiteModel(manifest, loaded));
  expect(html).toContain('Network mode</dt><dd>stub');
  expect(html).toContain('Record schema</dt><dd>2');
  expect(html.match(/Network mode<\/dt>/g)).toHaveLength(2);
});

test('report refuses --html equal to suite.json or a record, by path or by link', async () => {
  const sub = join(dir, 'guard');
  await mkdir(sub);
  await writeFile(join(sub, 'checkout.published.jsonl'), '{"type":"hit"}\n');
  await writeFile(join(sub, 'suite.json'), JSON.stringify(manifest));
  const before = await readFile(join(sub, 'suite.json'), 'utf8');
  await link(join(sub, 'suite.json'), join(dir, 'hard.html'));
  await symlink(join(sub, 'checkout.published.jsonl'), join(dir, 'soft.html'));
  for (const target of [join(sub, 'suite.json'), join(sub, 'checkout.published.jsonl'), join(dir, 'hard.html'), join(dir, 'soft.html')]) {
    expect(await main(['report', sub, '--html', target], io().io)).toBe(2);
  }
  expect(await readFile(join(sub, 'suite.json'), 'utf8')).toBe(before);
  expect(await readFile(join(sub, 'checkout.published.jsonl'), 'utf8')).toBe('{"type":"hit"}\n');
});

test('a failed cell with no record does not read as no leaks', () => {
  const failing: SuiteManifest = { ...manifest, cells: manifest.cells.map((c) => (c.scenario === 'gone' && c.variant === 'published' ? { ...c, status: 'fail' as const, exitCode: 1 as const } : c)) };
  const html = renderSuiteReport(buildSuiteModel(failing, loaded));
  expect(html).toContain('<li><strong>published:</strong> leaks not known, 1 run has no record</li>');
});
