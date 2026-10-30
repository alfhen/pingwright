import type { Hit, Result } from '@pingwright/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { countHits, exitCodeFor, formatSummary, type Summary } from './summary.ts';
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
    hits: { ga4: { purchase: 1 } },
    epochs: [{ label: 'undecided', startT: 0, endT: null }],
    flags: [{ kind: 'unknownDestination', detail: 'GET http://x.test/' }],
    results: [
      { expectation: 'must: a', pass: true, message: 'ok', evidence: [] },
      { expectation: 'mustNot: b', pass: false, message: 'found 1', evidence: ['hit_1'] },
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
  const text = formatSummary({ runId: 'r', path: 'p', pass: true, hits: {}, epochs: [], flags, results: [] });
  expect(text).toContain('unknownDestination: t.example.net x5 (/a, /b, /c and 1 more)');
  expect(text).toContain('unknownDestination: u.example.net x1 (/p)');
  expect(text).toContain('firstPartySubdomain: sgtm.example.com x1 (/collect)');
  expect(text).toContain('stubBypass: It was not routed: https://x.test/');
  expect(text).not.toContain('?x=1');
});

test('shows evidence for passing expectations, capped', () => {
  const ids = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'];
  const summary: Summary = {
    runId: 'run_1',
    path: 'p.jsonl',
    pass: true,
    hits: {},
    epochs: [],
    flags: [],
    results: [{ expectation: 'must: a', pass: true, message: 'ok', evidence: ids }],
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
      { command: 'run', scenario, site: 'http://localhost:1', network: undefined, out: dir, seed: undefined, headed: false, autoconsentRules: [], gtmOverride: undefined, trackerList: undefined, vars: { undeclared: 'x' }, json: false },
      { stdout: () => {}, stderr: (text) => stderr.push(text) },
    );
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('Warning: line 3');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
