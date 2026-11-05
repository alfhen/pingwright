import type { Hit, Result, RunRecords } from '@tagreeve/core';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { newId } from '@tagreeve/core';
import { applyBaseline, buildSummary, redactFlagDetail, countHits, exitCodeFor, formatDuration, formatSummary, type Summary } from './summary.ts';
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
  expect(readVersion()).toBe('0.6.0-rc.1');
  out.length = 0;
  expect(await main(['run', '--help'], io)).toBe(0);
  expect(out.join('')).toContain('Usage: tagreeve run <scenario.yml>');
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
      { command: 'run', scenario, site: 'http://localhost:1', network: undefined, out: dir, seed: undefined, headed: false, netLog: false, autoconsentRules: [], gtmOverride: undefined, trackerList: undefined, baseline: undefined, vars: { undeclared: 'x' }, json: false },
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

test('skipped optional fields are listed under their step and carried in the summary', () => {
  const records = {
    run: { id: 'run_1' },
    hits: [],
    consentEpochs: [],
    flags: [],
    steps: [{ label: 'start' }, { label: 'fill-1', skippedFields: ['#phone'] }],
  } as unknown as RunRecords;
  const summary = buildSummary(records, [result(true)], 'p');
  expect(summary.skippedFields).toEqual([{ step: 'fill-1', selector: '#phone' }]);
  expect(formatSummary(summary)).toContain('Skipped fields\n  fill-1\n    SKIPPED FIELD #phone (not present)');
});

test('a test payment prints one line with the provider and host, and carries names only', () => {
  const records = {
    run: { id: 'run_1', site: 'https://shop.example.com/checkout?token=abc' },
    hits: [],
    consentEpochs: [],
    flags: [],
    steps: [{ label: 'start' }, { label: 'payment-1', payment: { provider: 'shopify-bogus', mode: 'test', testMode: 'marker' } }],
  } as unknown as RunRecords;
  const summary = buildSummary(records, [result(true)], 'p');
  expect(summary.testPayment).toEqual({ provider: 'shopify-bogus', host: 'shop.example.com', testMode: 'marker' });
  const text = formatSummary(summary);
  expect(text.split('\n')[0]).toBe('TEST PAYMENT: shopify-bogus on shop.example.com (test mode on page)');
  expect(JSON.stringify(summary)).not.toMatch(/token|12\/40|"1"/);
  const without = buildSummary({ ...records, steps: [{ label: 'start' }] } as unknown as RunRecords, [result(true)], 'p');
  expect(without).not.toHaveProperty('testPayment');
  expect(formatSummary(without)).not.toContain('TEST PAYMENT');
});

test('a declared test payment says so in the summary line and the JSON object', () => {
  const records = {
    run: { id: 'run_1', site: 'https://shop.example.com/checkout' },
    hits: [],
    consentEpochs: [],
    flags: [],
    steps: [{ label: 'payment-1', payment: { provider: 'shopify-test', mode: 'test', testMode: 'declared' } }],
  } as unknown as RunRecords;
  const summary = buildSummary(records, [result(true)], 'p');
  expect(summary.testPayment).toEqual({ provider: 'shopify-test', host: 'shop.example.com', testMode: 'declared' });
  expect(formatSummary(summary).split('\n')[0]).toBe('TEST PAYMENT: shopify-test on shop.example.com (test mode declared)');
});

const noDrift = { drift: false, added: 0, removed: 0, countChanges: 0, warnings: [], changes: [] };

test('baseline drift sets pass and ok to false, and no drift leaves them', () => {
  const drifted = { ...base };
  applyBaseline(drifted, { ...noDrift, drift: true, added: 1 });
  expect(drifted).toMatchObject({ pass: false, ok: false });
  expect(drifted.baseline?.drift).toBe(true);
  const same = { ...base };
  applyBaseline(same, noDrift);
  expect(same).toMatchObject({ pass: true, ok: true });
});

test('lists platform hosts in one line per platform', () => {
  const flags = [
    { kind: 'platformHost', detail: 'GET https://cdn.shopify.com/a?x=1' },
    { kind: 'platformHost', detail: 'GET https://cdn.shopify.com/b?x=1' },
    { kind: 'platformHost', detail: 'GET https://unlisted.example.invalid/b?x=1' },
  ];
  const text = formatSummary({ runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags, results: [] });
  expect(text).toContain('platformHost: shopify, 2 requests to 1 host (cdn 2)');
  expect(text).toContain('platformHost: GET https://unlisted.example.invalid/b?x');
});

test('platformHost summary lines hold names and counts only', () => {
  const email = 'pw-fixture@example.com';
  const values = [email, createHash('sha256').update(email).digest('hex'), encodeURIComponent(email), 'pwfake-cookie-value-0001'];
  const url = `https://cdn.shopify.com/a/${values[1]}?e=${values[0]}&u=${values[2]}&c=${values[3]}`;
  for (const v of values) expect(url).toContain(v);
  const flags = [{ kind: 'platformHost', detail: `GET ${url}` }];
  const text = formatSummary({ runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags, results: [] });
  expect(text).toContain('platformHost: shopify, 1 request to 1 host (cdn 1)');
  for (const v of values) expect(text).not.toContain(v);
});

test('a run from the stand-in container says so in the summary and in --json', () => {
  const records = { run: { id: 'run_x', testServerContainer: true }, hits: [], consentEpochs: [], flags: [], steps: [] } as unknown as RunRecords;
  const summary = buildSummary(records, [], 'run.jsonl');
  expect(summary.testServerContainer).toBe(true);
  expect(formatSummary(summary)).toContain('Server container: stand-in container (test seam)');
  const plain = buildSummary({ ...records, run: { id: 'run_x' } } as unknown as RunRecords, [], 'run.jsonl');
  expect(plain).not.toHaveProperty('testServerContainer');
  expect(formatSummary(plain)).not.toContain('stand-in');
});

function serverRecords(error?: string): RunRecords {
  const runId = newId('run');
  const requests = [0, 1, 2, 3].map((i) => ({ type: 'request', id: newId('request'), runId, t: i, captured: 'serverContainer' }));
  const browser = { type: 'hit', id: newId('hit'), runId, requestId: newId('request'), t: 0, vendor: 'meta', event: 'Purchase' };
  const via = (confidence: string) => ({ hitId: browser.id, by: 'eventId', confidence });
  const sent = (i: number, extra: object) => ({ type: 'hit', id: newId('hit'), runId, requestId: requests[i]!.id, t: 10 + i, vendor: 'ga4', event: 'purchase', ...extra });
  const hits = [browser, sent(0, { via: via('exact') }), sent(1, { via: via('exact') }), sent(2, { via: via('probable'), linkMiss: { eventId: 'none', clientId: 'answeredBefore' } }), sent(3, { linkMiss: { eventId: 'noMatch', clientId: 'answeredBefore' } })];
  return {
    run: { id: runId, serverContainer: { image: 'tagreeve-sgtm:1@sha256:abc', startedAt: 0, requests: 4, refused: 0, unlinked: 1, passThrough: { serverjs: 1, config: 1, destination: 1 }, ...(error && { error }) } },
    hits,
    requests,
    consentEpochs: [],
    flags: [],
    steps: [],
  } as unknown as RunRecords;
}

test('the summary counts the server container calls by link, in the line and in --json', () => {
  const summary = buildSummary(serverRecords(), [], 'run.jsonl');
  expect(summary.serverContainer).toEqual({ calls: 4, exact: 2, probable: 1, unlinked: 1, forwarded: 3, notExact: { eventId: { none: 1, noMatch: 1, several: 0 }, clientId: { noClientId: 0, noSameKeyHit: 0, severalSameKeyHits: 0, answeredBefore: 2 } } });
  const text = formatSummary(summary);
  expect(text).toContain('Server container: image ok; 4 vendor calls, 2 linked exactly, 1 probable, 1 unlinked; 3 requests forwarded to Google');
  expect(text).toContain('Not shown: Stape-only features');
  expect(JSON.parse(JSON.stringify(summary)).serverContainer.calls).toBe(4);
});

test('notExact holds counts only and is not in the text line', () => {
  const summary = buildSummary(serverRecords(), [], 'run.jsonl');
  const json = JSON.stringify(summary.serverContainer?.notExact);
  expect(json).not.toMatch(/hit_|request_|run_/);
  expect(formatSummary(summary)).not.toContain('notExact');
});

test('a container that failed shows its error class, and the stand-in stays marked', () => {
  const failed = formatSummary(buildSummary(serverRecords('exited'), [], 'run.jsonl'));
  expect(failed).toContain('Server container: failed (exited); 4 vendor calls');
  const records = serverRecords();
  records.run.testServerContainer = true;
  expect(formatSummary(buildSummary(records, [], 'run.jsonl'))).toContain('Server container: stand-in container (test seam); 4 vendor calls');
});

test('a run without a container has no serverContainer field and no line', () => {
  const plain = buildSummary({ run: { id: 'run_x' }, hits: [], requests: [], consentEpochs: [], flags: [], steps: [] } as unknown as RunRecords, [], 'run.jsonl');
  expect(plain).not.toHaveProperty('serverContainer');
  expect(formatSummary(plain)).not.toContain('Server container');
});

test('the summary line holds no config, container ID or host', () => {
  const text = formatSummary(buildSummary(serverRecords(), [], 'run.jsonl'));
  for (const bad of ['GTM-', 'auth=', 'sha256', 'http']) expect(text).not.toContain(bad);
});

const EMAIL = 'pw-test.user%40example.test';
const HASH = 'a'.repeat(64);

test.each([
  ['unknownDestination', `GET https://t.example.net/px/a?email=${EMAIL}&h=${HASH}&x=1#top`, 'GET https://t.example.net/px/a?email&h&x'],
  ['firstPartySubdomain', `POST https://sgtm.example.com/collect?em=${EMAIL}&em=2`, 'POST https://sgtm.example.com/collect?em'],
  ['platformHost', 'GET https://www.googletagmanager.com/gtag/js?id=G-PWTEST0001', 'GET https://www.googletagmanager.com/gtag/js?id'],
  ['unknownDestination', `from the server container: POST https://s.example.net/g/collect?cid=1.2&e=${EMAIL}`, 'from the server container: POST https://s.example.net/g/collect?cid&e'],
  ['stubBypass', `It was not routed, so it was not stubbed: https://px.example.net/c?u=${EMAIL}`, 'It was not routed, so it was not stubbed: https://px.example.net/c?u'],
  ['possibleRedirectHop', 'It failed with no response; Chromium may have followed a redirect that was not recorded and not stubbed: https://px.example.net/r?to=https%3A%2F%2Fa.test', 'It failed with no response; Chromium may have followed a redirect that was not recorded and not stubbed: https://px.example.net/r?to'],
  ['sandboxPageUrl', `ga4 received https://shop.example.com/web-pixels@abc/sandbox/modern/?email=${EMAIL} as the page`, 'ga4 received https://shop.example.com/web-pixels@abc/sandbox/modern/?email as the page'],
])('buildSummary shows %s with query names only', (kind, detail, shown) => {
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [{ kind, detail }], steps: [] } as unknown as RunRecords;
  const summary = buildSummary(records, [], 'p');
  expect(summary.flags).toEqual([{ kind, detail: shown }]);
  expect(JSON.stringify(summary)).not.toMatch(/example\.test|pw-test|aaaaaaaa|G-PWTEST/);
});

test('a value-like query name is shown as (other)', () => {
  expect(redactFlagDetail(`GET https://t.example.net/u/a?${EMAIL}=1&${HASH}&ok=2`)).toBe('GET https://t.example.net/u/a?(other)&ok');
  expect(redactFlagDetail('GET https://user:secret@t.example.net/a')).toBe('GET https://t.example.net/a');
});

test('the summary of a name=value URL is the same after buildSummary then formatFlags', () => {
  const detail = `GET https://t.example.net/a?email=${EMAIL}&h=${HASH}&sid=pwfake-cookie-value-0001`;
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [{ kind: 'stubBypass', detail }], steps: [] } as unknown as RunRecords;
  const summary = buildSummary(records, [], 'p');
  expect(summary.flags[0]!.detail).toBe('GET https://t.example.net/a?email&h&sid');
  expect(formatSummary(summary)).toContain('stubBypass: GET https://t.example.net/a?email&h&sid\n');
});

test('the text summary prints a built summary without values and keeps the grouped lines', () => {
  const flags = [
    { kind: 'stubBypass', detail: `It was not routed, so it was not stubbed: https://px.example.net/c?u=${EMAIL}` },
    { kind: 'unknownDestination', detail: `GET https://t.example.net/a?email=${EMAIL}` },
    { kind: 'platformHost', detail: `GET https://www.googletagmanager.com/gtag/js?id=${EMAIL}` },
  ];
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags, steps: [] } as unknown as RunRecords;
  const text = formatSummary(buildSummary(records, [], 'p'));
  expect(text).toContain('stubBypass: It was not routed, so it was not stubbed: https://px.example.net/c?u');
  expect(text).toContain('unknownDestination: t.example.net x1 (/a)');
  expect(text).not.toMatch(/example\.test|pw-test/);
});

const FAKE_EMAIL = 'pw-test.user@example.test';
const PHONE = '+15555550123';

test.each([
  ['absolute', 'GET https://t.example.net/a/b?email=1&x=2', 'GET https://t.example.net/a/b?email&x'],
  ['protocol-relative', 'GET //t.example.net/a?email=1&x=2', 'GET //t.example.net/a?email&x'],
  ['relative', 'GET /a/b?email=1&x=2#frag', 'GET /a/b?email&x'],
  ['relative after a colon', 'It was not routed, so it was not stubbed: /px?email=1', 'It was not routed, so it was not stubbed: /px?email'],
  ['with a space in the query', 'GET https://t.example.net/a?email=a b&x=c d', 'GET https://t.example.net/a?email&x'],
  ['with a space in the path', 'GET https://t.example.net/a/b c/d?x=1', 'GET https://t.example.net/a/(other)/d?x'],
  ['a space in the query name', 'GET /a?pw fake name=1', 'GET /a?(other)'],
])('redactFlagDetail redacts a %s URL', (_form, detail, shown) => {
  expect(redactFlagDetail(detail)).toBe(shown);
});

test.each([
  ['relative', `ga4 received /web-pixels@abc/sandbox/modern/account/${FAKE_EMAIL}?email=${FAKE_EMAIL} as the page`, 'ga4 received /web-pixels@abc/sandbox/modern/account/(other)?email as the page'],
  ['protocol-relative', 'meta received //shop.example.com/web-pixels@abc/sandbox/modern/?sid=pwfake-cookie-value-0001 as the page', 'meta received //shop.example.com/web-pixels@abc/sandbox/modern/?sid as the page'],
  ['with a space', 'ga4 received https://shop.example.com/web-pixels@abc/sandbox/modern/cart?q=a b c as the page', 'ga4 received https://shop.example.com/web-pixels@abc/sandbox/modern/cart?q as the page'],
  ['holding " received "', 'ga4 received /web-pixels@abc/sandbox/modern/?q=pw-test@example.test received x as the page', 'ga4 received /web-pixels@abc/sandbox/modern/?q as the page'],
])('the sandboxPageUrl page is redacted when it is %s', (_form, detail, shown) => {
  expect(redactFlagDetail(detail)).toBe(shown);
});

test('a path segment that holds an email, a phone or a hash reads (other)', () => {
  const detail = `GET https://t.example.net/account/${FAKE_EMAIL}/${encodeURIComponent(PHONE)}/${HASH}/orders`;
  expect(redactFlagDetail(detail)).toBe('GET https://t.example.net/account/(other)/(other)/(other)/orders');
});

test('a sandbox prefix keeps its web-pixels hash and mode', () => {
  expect(redactFlagDetail(`ga4 received https://shop.example.com/web-pixels@${'a1b2c3'.repeat(6)}/custom/web-pixel-1@1/sandbox/modern/cart/${HASH} as the page`)).toBe(
    `ga4 received https://shop.example.com/web-pixels@${'a1b2c3'.repeat(6)}/custom/web-pixel-1@1/sandbox/modern/cart/(other) as the page`,
  );
});

test('a bare query item reads (other) and a name=value item shows its name', () => {
  expect(redactFlagDetail('GET https://t.example.net/a?pwfake-cookie-value-0001')).toBe('GET https://t.example.net/a?(other)');
  expect(redactFlagDetail('GET https://t.example.net/a?ok=1&pwfake-cookie-value-0001')).toBe('GET https://t.example.net/a?ok&(other)');
});

test('a percent-encoded separator in a query name does not split it', () => {
  expect(redactFlagDetail('GET https://t.example.net/a?k%26sid%3Dpwfake-cookie-value-0001=1&ok=2')).toBe('GET https://t.example.net/a?(other)&ok');
});

test('a buildSummary flag with a relative page leaks nothing', () => {
  const detail = `ga4 received /web-pixels@abc/sandbox/modern/account/${FAKE_EMAIL}?email=${FAKE_EMAIL}&sid=pwfake-cookie-value-0001 as the page`;
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [{ kind: 'sandboxPageUrl', detail }], steps: [] } as unknown as RunRecords;
  const summary = buildSummary(records, [], 'p');
  for (const output of [JSON.stringify(summary), formatSummary(summary)]) expect(output).not.toMatch(/example\.test|pw-test|pwfake-cookie/);
});

test('the summary has a Label line only when the run has a label', () => {
  const base: Summary = { runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags: [], results: [] };
  expect(formatSummary({ ...base, label: 'ca-307' }).split('\n')[0]).toBe('Label: ca-307');
  expect(formatSummary(base)).not.toContain('Label:');
});

test('buildSummary carries the run label and omits the key without one', () => {
  const records = (label?: string) => ({ run: { id: 'run_1', ...(label && { label }) }, hits: [], consentEpochs: [], flags: [] }) as unknown as RunRecords;
  expect(buildSummary(records('ca-307'), [], 'p').label).toBe('ca-307');
  expect(buildSummary(records(), [], 'p')).not.toHaveProperty('label');
});

test('the Defaults line names each default used and is absent without one', () => {
  const base: Summary = { runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags: [], results: [] };
  expect(formatSummary(base)).not.toContain('Defaults:');
  const text = formatSummary({ ...base, defaults: [{ setting: 'trackerList', path: 'tagreeve/trackers.json' }] });
  expect(text).toContain('Defaults: tagreeve/trackers.json (tracker list)');
});

test('the Defaults line names the project config first, and a --config path is not a default', () => {
  const base: Summary = { runId: 'r', path: 'p', pass: true, ok: true, hits: {}, epochs: [], flags: [], results: [] };
  const text = formatSummary({ ...base, defaults: [{ setting: 'config', path: 'tagreeve/config.yml' }, { setting: 'trackerList', path: 'tagreeve/trackers.json' }] });
  expect(text).toContain('Defaults: tagreeve/config.yml (project config), tagreeve/trackers.json (tracker list)');
  expect(formatSummary({ ...base, defaults: [{ setting: 'config', path: 'tagreeve/config.yml' }] })).toContain('Defaults: tagreeve/config.yml (project config)');
});

test('the dataLayer line counts pushes and events, and no pushed value reaches the summary', () => {
  const dle = (event: string, id: number) => ({ id: `dle_${id}`, stepId: null, event, args: [{ event, secret: 'value-1' }], isConsentCommand: false, frame: { main: true, n: 0 } });
  const records = {
    run: { id: 'run_1' },
    hits: [],
    consentEpochs: [],
    flags: [],
    steps: [],
    dataLayerEvents: [dle('purchase', 1), dle('purchase', 2), dle('add_to_cart', 3), dle('view_item', 4), dle('page_view', 5)],
  } as unknown as RunRecords;
  const summary = buildSummary(records, [result(true)], 'p');
  expect(summary.dataLayer!.pushes).toBe(5);
  const text = formatSummary(summary);
  expect(text).toContain('dataLayer: 5 pushes, 4 events (add_to_cart, page_view, purchase, …); shapes in --json');
  expect(JSON.stringify(summary)).not.toContain('value-1');
});

test('a run with no pushes has no dataLayer line or field', () => {
  const records = { run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [], steps: [], dataLayerEvents: [] } as unknown as RunRecords;
  const summary = buildSummary(records, [result(true)], 'p');
  expect(summary).not.toHaveProperty('dataLayer');
  expect(formatSummary(summary)).not.toContain('dataLayer');
});

const tagRecords = (over: Record<string, unknown>) => ({ run: { id: 'run_1' }, hits: [], consentEpochs: [], flags: [], steps: [], dataLayerEvents: [], tagReports: [], ...over }) as unknown as RunRecords;
const tagReport = (id: string, tags: { id: string; name: string | null; status: string }[], container = 'GTM-PWTEST1') => ({ type: 'tagReport', id, container, side: 'web', event: 'gtm.js', t: 1, tags });
const gtmOverride = (expectedTags: { id: string; name: string | null }[], container = 'GTM-PWTEST1') => ({ container, gtmPreview: 'env-1', gtmAuth: '[redacted]', applied: [], expectedTags });

test('the Tags line counts fired and failed tags and names the expected tags that did not fire', () => {
  const records = tagRecords({
    run: { id: 'run_1', gtmOverride: gtmOverride([{ id: '13', name: 'Meta - PageView' }, { id: '45', name: 'GA4 - Purchase' }]) },
    tagReports: [tagReport('tag_1', [{ id: '11', name: 'GA4 - Config', status: 'success' }, { id: '13', name: null, status: 'failure' }, { id: '14', name: null, status: 'success' }])],
  });
  const summary = buildSummary(records, [result(true)], 'p');
  expect(formatSummary(summary)).toContain('Tags GTM-PWTEST1: 3 fired, 1 failed (13 Meta - PageView: failure), 1 expected did not fire (45 GA4 - Purchase)');
  expect(summary.tags!['GTM-PWTEST1']).toMatchObject({ reports: 1, notFired: [{ id: '45', name: 'GA4 - Purchase' }] });
});

test('an override run with no report says so, and --json has one shape with the hint', () => {
  const summary = buildSummary(tagRecords({ run: { id: 'run_1', gtmOverride: gtmOverride([{ id: '45', name: null }]) } }), [result(true)], 'p');
  expect(formatSummary(summary)).toContain('Tags: no reports from GTM-PWTEST1. Install the reporter: tagreeve template web --json');
  expect(summary.tags).toEqual({ 'GTM-PWTEST1': { reports: 0, hint: 'tagreeve template web --json' } });
});

test('reports without an override give fired tags and a null notFired', () => {
  const summary = buildSummary(tagRecords({ tagReports: [tagReport('tag_1', [{ id: '11', name: 'GA4 - Config', status: 'success' }])] }), [result(true)], 'p');
  expect(formatSummary(summary)).toContain('Tags GTM-PWTEST1: 1 fired');
  expect(summary.tags!['GTM-PWTEST1']).toMatchObject({ notFired: null });
});

test('a run with no reports and no override has no Tags line or field', () => {
  const summary = buildSummary(tagRecords({}), [result(true)], 'p');
  expect(summary).not.toHaveProperty('tags');
  expect(formatSummary(summary)).not.toContain('Tags');
});

test('tag names in the summary are masked: an email reads (other), the redacted auth stays', () => {
  const records = tagRecords({
    tagReports: [tagReport('tag_1', [{ id: '88', name: 'Lead - pw-fixture@example.com', status: 'failure' }, { id: '89', name: '[redacted]', status: 'success' }])],
  });
  const summary = buildSummary(records, [result(true)], 'p');
  const text = formatSummary(summary);
  expect(text).toContain('88 (other): failure');
  expect(JSON.stringify(summary) + text).not.toContain('pw-fixture');
  expect(JSON.stringify(summary)).toContain('[redacted]');
});

test('a checkout token or a GID in a tag name reads (other) in the JSON and the text', () => {
  const records = tagRecords({
    tagReports: [tagReport('tag_1', [
      { id: '90', name: 'Thanks /checkouts/c/0f3e9a7b2c1d4e5f6a7b8c9d0e1f2a3b/thank-you', status: 'failure' },
      { id: '91', name: 'Order gid://shopify/Order/5551234567890', status: 'failure' },
    ])],
  });
  const summary = buildSummary(records, [result(true)], 'p');
  const all = JSON.stringify(summary) + formatSummary(summary);
  expect(all).not.toContain('0f3e9a7b');
  expect(all).not.toContain('5551234567890');
  expect(formatSummary(summary)).toContain('90 (other): failure');
  expect(formatSummary(summary)).toContain('91 (other): failure');
});
