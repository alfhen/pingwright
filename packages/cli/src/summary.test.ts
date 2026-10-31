import type { Hit, Result, RunRecords } from '@pingwright/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { buildSummary, countHits, exitCodeFor, formatDuration, formatSummary, type Summary } from './summary.ts';
import { main } from './main.ts';
import { runCommand } from './run.ts';
import { readVersion } from './version.ts';

const hit = (vendor: string, event: string | null) => ({ vendor, event }) as Hit;
const result = (pass: boolean) => ({ expectation: 'x', pass, evidence: [] }) as unknown as Result;

test('counts hits per vendor and event', () => {
  expect(countHits([hit('ga4', 'page_view'), hit('ga4', 'page_view'), hit('ga4', null), hit('meta', 'PageView')])).toEqual({
    ga4: { page_view: 2, '(no event)': 1 },
    meta: { PageView: 1 },
  });
});

test('exit code is 1 when any result fails', () => {
  expect(exitCodeFor([result(true), result(true)])).toBe(0);
  expect(exitCodeFor([result(true), result(false)])).toBe(1);
});

test('formats failures with message and evidence, and the record path', () => {
  const summary: Summary = {
    runId: 'run_1',
    path: 'runs/run_1.jsonl',
    pass: false,
    ok: false,
    hits: { ga4: { purchase: 1 } },
    epochs: [{ label: 'undecided', startT: 0, endT: null }],
    flags: [{ kind: 'unknownDestination', detail: 'GET http://x.test/' }],
    results: [
      { expectation: 'must: a', pass: true, severity: 'fail', message: 'ok', evidence: [] },
      { expectation: 'mustNot: b', pass: false, severity: 'fail', message: 'found 1', evidence: ['hit_1'] },
    ],
  };
  const text = formatSummary(summary);
  expect(text).toContain('ga4: purchase x1');
  expect(text).toContain('PASS must: a');
  expect(text).toContain('FAIL mustNot: b');
  expect(text).toContain('evidence: hit_1');
  expect(text).toContain('Result: fail (1 of 2)');
  expect(text.trimEnd().endsWith('Record: runs/run_1.jsonl')).toBe(true);
});

test('groups unknown and first-party flags by host with counts and a few paths', () => {
  const flags = [
    ...['a', 'b', 'c', 'd', 'a'].map((p) => ({ kind: 'unknownDestination', detail: `GET https://t.example.net/${p}?x=1` })),
    { kind: 'unknownDestination', detail: 'POST https://u.example.net/p' },
    { kind: 'firstPartySubdomain', detail: 'POST https://sgtm.example.com/collect' },
    { kind: 'stubBypass', detail: 'It was not routed: https://x.test/' },
  ];
  const text = formatSummary({ runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags, results: [] });
  expect(text).toContain('unknownDestination: t.example.net x5 (/a, /b, /c and 1 more)');
  expect(text).toContain('unknownDestination: u.example.net x1 (/p)');
  expect(text).toContain('firstPartySubdomain: sgtm.example.com x1 (/collect)');
  expect(text).toContain('stubBypass: It was not routed: https://x.test/');
  expect(text).not.toContain('?x=1');
});

test('groups sandboxPageUrl flags by vendor with a count and an example path', () => {
  const sandbox = 'https://shop.example.com/web-pixels@abc/sandbox/modern/checkout';
  const flags = [
    ...[1, 2, 3].map((n) => ({ kind: 'sandboxPageUrl', detail: `ga4 received ${sandbox}?n=${n} as the page` })),
    { kind: 'sandboxPageUrl', detail: `meta received ${sandbox} as the page` },
  ];
  const text = formatSummary({ runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags, results: [] });
  expect(text).toContain('sandboxPageUrl: ga4 x3 (/web-pixels@abc/sandbox/modern/checkout)');
  expect(text).toContain('sandboxPageUrl: meta x1 (/web-pixels@abc/sandbox/modern/checkout)');
  expect(text).not.toContain('received');
  expect(text).not.toContain('?n=');
});

test('shows evidence for passing expectations, capped', () => {
  const ids = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];
  const summary: Summary = {
    runId: 'run_1',
    path: 'p.jsonl',
    pass: true,
    ok: true,
    hits: {},
    epochs: [],
    flags: [],
    results: [{ expectation: 'must: a', pass: true, severity: 'fail', message: 'ok', evidence: ids }],
  };
  const text = formatSummary(summary);
  expect(text).toContain('evidence: h1, h2, h3, h4, h5 and 2 more');
  expect(text).not.toContain('h6');
});

test('main prints the version and exits 2 on a usage error', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) };
  expect(await main(['--version'], io)).toBe(0);
  expect(out.join('')).toBe(`${readVersion()}\n`);
  expect(readVersion()).toBe('0.3.0-rc.2');
  out.length = 0;
  expect(await main(['run', '--help'], io)).toBe(0);
  expect(out.join('')).toContain('Usage: pingwright run <scenario.yml>');
  expect(out.join('')).not.toContain('install-browser');
  expect(await main(['run', 's.yml'], io)).toBe(2);
  expect(err.join('')).toContain('--site is required');
});

test('shows the withdrawn label with the state in the epochs lines', () => {
  const summary: Summary = {
    runId: 'run_1',
    path: 'runs/run_1.jsonl',
    pass: true,
    ok: true,
    hits: {},
    epochs: [
      { label: 'undecided', startT: 0, endT: 10 },
      { label: 'withdrawn', state: 'mixed', startT: 10, endT: null },
    ],
    flags: [],
    results: [],
  };
  const text = formatSummary(summary);
  expect(text).toContain('  undecided (10 ms)');
  expect(text).toContain('  withdrawn, mixed (to end)');
});

test('prints a scenario warning to stderr before running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-warn-'));
  try {
    const scenario = join(dir, 'scenario.yml');
    await writeFile(scenario, 'start: /\nsteps:\n  - fill: { "#email": "jane.doe@gmail.com" }\n');
    const stderr: string[] = [];
    const code = await runCommand(
      { command: 'run', scenario, site: 'http://localhost:1', network: undefined, out: dir, seed: undefined, headed: false, netLog: false, autoconsentRules: [], gtmOverride: undefined, trackerList: undefined, vars: { undeclared: 'x' }, json: false },
      { stdout: () => {}, stderr: (text) => stderr.push(text) },
    );
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('Warning: line 3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('epoch durations are rounded: ms under a second, seconds with one decimal above', () => {
  expect(formatDuration(850)).toBe('850 ms');
  expect(formatDuration(849.6)).toBe('850 ms');
  expect(formatDuration(5628.000244140625)).toBe('5.6 s');
  expect(formatDuration(1000)).toBe('1.0 s');
  expect(formatDuration(999.6)).toBe('1.0 s');
  const summary: Summary = {
    runId: 'run_1',
    path: 'runs/run_1.jsonl',
    pass: true,
    ok: true,
    hits: {},
    epochs: [{ label: 'undecided', startT: 100, endT: 5728.000244140625 }],
    flags: [],
    results: [],
  };
  expect(formatSummary(summary)).toContain('  undecided (5.6 s)');
});

test('a failed warn result does not change the exit code', () => {
  const warn = { ...result(false), severity: 'warn' as const };
  expect(exitCodeFor([result(true), warn])).toBe(0);
  expect(exitCodeFor([warn, result(false)])).toBe(1);
});

const base: Summary = { runId: 'run_1', path: 'runs/run_1.jsonl', pass: true, ok: true, hits: {}, epochs: [], flags: [], results: [] };

test('a failed warn result prints a WARN line, its message and a warning count', () => {
  const text = formatSummary({
    ...base,
    pass: false,
    results: [
      { expectation: 'a', pass: true, severity: 'fail', message: undefined, evidence: [] },
      { expectation: 'b', pass: false, severity: 'warn', message: 'b went wrong', evidence: [] },
    ],
  });
  expect(text).toContain('  WARN b\n       b went wrong');
  expect(text).toContain('Result: pass with 1 warning');
  const mixed = formatSummary({
    ...base,
    results: [
      { expectation: 'a', pass: false, severity: 'fail', message: 'x', evidence: [] },
      { expectation: 'b', pass: false, severity: 'warn', message: 'y', evidence: [] },
    ],
  });
  expect(mixed).toContain('Result: fail (1 of 2) with 1 warning');
});

test('possibleRealData flags collapse into one counted line', () => {
  const flags = Array.from({ length: 4 }, (_, i) => ({ kind: 'possibleRealData', detail: `request req_${i} carries 1 email value(s)` }));
  const text = formatSummary({ ...base, flags });
  expect(text).toContain('  possibleRealData: x4');
  expect(text).not.toContain('req_0');
});

test('sandboxPageUrl shows one example path', () => {
  const flags = ['a', 'b', 'c'].map((p) => ({ kind: 'sandboxPageUrl', detail: `meta received https://shop.example.com/${p}/sandbox/x as the page` }));
  const text = formatSummary({ ...base, flags });
  expect(text).toContain('sandboxPageUrl: meta x3 (/a/sandbox/x and 2 more)');
});

test('every --json result carries a severity, fail when the record has none', () => {
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [] } as unknown as RunRecords;
  const warn = { ...result(false), severity: 'warn' as const };
  const summary = buildSummary(records, [result(true), result(false), warn, { ...result(true), severity: 'warn' as const }], 'p');
  expect(summary.results.map((r) => r.severity)).toEqual(['fail', 'fail', 'warn', 'warn']);
});

test.each([
  ['nestedNameOnly', 'a plain name matches a top-level field only; use **.name to match at any depth'],
  ['stubNoCookies', 'stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies'],
] as const)('prints the %s note under a passing result and keeps the code in the summary', (note, text) => {
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [] } as unknown as RunRecords;
  const passing = { expectation: 'mustNot: a', pass: true, evidence: [], note, message: 'secret-field' } as unknown as Result;
  const summary = buildSummary(records, [passing, result(true)], 'runs/run_1.jsonl');
  expect(summary.results[0]!.note).toBe(note);
  expect(summary.results[1]).not.toHaveProperty('note');
  const lines = formatSummary(summary).split('\n');
  const at = lines.indexOf('  PASS mustNot: a');
  expect(lines[at + 1]).toBe(`       note: ${text}`);
  expect(lines.join('\n')).not.toContain('secret-field');
});
