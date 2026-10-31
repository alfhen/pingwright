import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

interface Summary {
  results: { expectation: string; pass: boolean; message: string; evidence: string[] }[];
}

async function cookieRun(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as Summary;
  const result = summary.results.find((x) => x.expectation.includes('cookie') && x.expectation.startsWith('must'))!;
  const note = r.records!.results.find((x) => x.expectation === result.expectation)?.note;
  return { ...r, result, note, records: r.records! };
}

test('mustNot cookie before consent fails and names the request that set it', async () => {
  const { code, result, records, stdout, stderr } = await cookieRun('cookies-before');
  expect(code).toBe(1);
  expect(stdout + stderr + JSON.stringify(records.results)).not.toMatch(/pwfake/);
  expect(result.pass).toBe(false);
  const setter = records.requests.find((q) => new URL(q.url).pathname === '/session/start')!;
  expect(result.evidence).toEqual([setter.id]);
  expect(result.message).toContain('_pwid');
}, 90_000);

test('the same cookie set after the answer passes', async () => {
  const { code, result } = await cookieRun('cookies-after');
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
}, 90_000);

test('a script cookie is found through a checkpoint', async () => {
  const { code, result, records } = await cookieRun('cookies-script');
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
  expect(result.evidence).toContain(records.checkpoints.find((c) => c.label === 'early')!.id);
  expect(result.message).toContain('not when it was set');
}, 90_000);

test('stub mode does not see the cookie of the stubbed loader request and says why', async () => {
  const { code, result, note, records } = await cookieRun('cookies-stub-loader');
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
  expect(note).toBe('stubNoCookies');
  expect(result.message.endsWith('stub mode: stubbed endpoints set no cookies')).toBe(true);
  expect(records.run.networkMode).toBe('stub');
  expect(records.responses.some((x) => x.setCookieNames.includes('_pwdcid'))).toBe(false);
  expect(records.checkpoints.some((c) => c.cookies.some((x) => x.name === '_pwdcid'))).toBe(false);
}, 90_000);

test('server mode lets the mock host answer, and only that host passes', async () => {
  const { code, result, note, records, stdout, stderr } = await cookieRun('cookies-server');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(stdout + stderr + JSON.stringify(records.results)).not.toMatch(/pwfake/);
  expect(note).toBeUndefined();
  expect(records.run.networkMode).toBe('server');
  const loader = records.requests.find((q) => new URL(q.url).pathname === '/pwcookie')!;
  expect(loader.outcome).toBe('passed');
  expect(result.evidence).toEqual([loader.id]);
  expect(stderr).not.toContain('Warning: server mode');
  const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
  for (const q of records.requests.filter((x) => x.outcome === 'passed')) expect(loopback.has(new URL(q.url).hostname)).toBe(true);
}, 90_000);
