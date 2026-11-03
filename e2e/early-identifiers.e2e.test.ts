import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

const FIXTURE_EMAIL = 'pw-fixture@example.com';
const FIXTURE_HASH = 'c57ca7ee07d1c5f5e3c2b5e993e9863c0677fd15765ffa52e86946c4f512dfa6';

interface Summary {
  results: { expectation: string; pass: boolean; severity?: string; message: string; evidence: string[] }[];
}

async function early(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as Summary;
  return { code: r.code, stdout: r.stdout, result: summary.results.find((x) => x.expectation === 'builtin: earlyIdentifiers'), records: r.records! };
}

test('a Meta hit with ud[em] before any answer warns, names the field and keeps exit 0', async () => {
  const { code, result, records, stdout } = await early('early-identifiers');
  expect(code).toBe(0);
  expect(result).toBeDefined();
  expect(result!.pass).toBe(false);
  expect(result!.severity).toBe('warn');
  expect(result!.message).toContain('before the consent answer: meta ud[em] (ads unknown)');
  const hit = records.hits.find((h) => h.vendor === 'meta' && h.idFields?.includes('ud[em]'));
  expect(hit).toBeDefined();
  expect(result!.evidence).toEqual([hit!.id]);
  const text = JSON.stringify(result) + stdout;
  for (const secret of [FIXTURE_EMAIL, FIXTURE_HASH, records.run.identity!.email]) expect(text).not.toContain(secret);
}, 90_000);

test('no email, hash or fbp value reaches stdout, stderr or the text output', async () => {
  const fbp = 'fb.1.1700000000000.100000001';
  const cookieValue = 'pw-fixture-cookie-value';
  const json = await run('early-identifiers-leak');
  const text = await runText('early-identifiers-leak');
  const records = json.records!;
  const summary = JSON.parse(json.stdout) as Summary;
  const hit = records.hits.find((h) => h.vendor === 'meta' && h.fields?.includes('fbp') && h.idFields?.includes('ud[em]'));
  expect(hit).toBeDefined();
  expect(records.requests.some((q) => q.url.includes(fbp) && q.url.includes(encodeURIComponent(FIXTURE_EMAIL)) && q.url.includes(FIXTURE_HASH))).toBe(true);
  expect(records.requests.some((q) => q.url.includes(cookieValue))).toBe(true);
  const result = summary.results.find((x) => x.expectation === 'builtin: earlyIdentifiers')!;
  expect(result.pass).toBe(false);
  expect(result.evidence).toEqual([hit!.id]);
  expect(text.stdout).toContain('earlyIdentifiers');
  const secrets = [FIXTURE_EMAIL, encodeURIComponent(FIXTURE_EMAIL), FIXTURE_HASH, fbp, cookieValue, records.run.identity!.email];
  for (const stream of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    for (const secret of secrets) expect(stream).not.toContain(secret);
  }
}, 150_000);

test('earlyIdentifiers: fail turns the same hit into exit 1', async () => {
  const { code, result } = await early('early-identifiers-fail');
  expect(code).toBe(1);
  expect(result!.pass).toBe(false);
  expect(result!.severity).toBe('fail');
}, 90_000);

test('a Meta hit with only fbp passes', async () => {
  const { code, result, records } = await early('early-identifiers-fbp');
  const hit = records.hits.find((h) => h.vendor === 'meta' && h.fields?.includes('fbp'));
  expect(hit).toBeDefined();
  expect(hit!.idFields).toEqual([]);
  expect(code).toBe(0);
  expect(result!.pass).toBe(true);
}, 90_000);
