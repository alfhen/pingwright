import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

async function realDataResult(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
  const check = summary.results.find((x) => x.expectation === 'builtin: possibleRealData') as { pass: boolean; message: string; evidence: string[] } | undefined;
  return check && { ...check, requests: r.records!.requests.filter((q) => check.evidence.includes(q.id)) };
}

test('a stable hashed client ID under many keys and an hmac parameter pass possibleRealData', async () => {
  const real = await realDataResult('stable-ids');
  expect(real?.message).toContain('found none');
  expect(real?.pass).toBe(true);
}, 90_000);

test('persisted-query IDs and a hashed asset name pass possibleRealData', async () => {
  const real = await realDataResult('shared-hashes');
  expect(real?.message).toContain('found none');
  expect(real?.pass).toBe(true);
}, 90_000);

test('a hashed non-identity email on a tracking request still fails possibleRealData next to persisted-query IDs', async () => {
  const real = await realDataResult('shared-hashes-leak');
  expect(real?.pass).toBe(false);
  expect(real?.message).toContain('not from the run identity');
}, 90_000);

test.each([
  ['shared-hashes-leak-nested', (q: { postData: string | null }) => q.postData?.includes('"customer"')],
  ['shared-hashes-leak-pixel', (q: { url: string }) => /\/shared-hashes\/u-[0-9a-f]{64}\.gif$/.test(q.url)],
])('%s: a hashed non-identity email where a skip rule could hide it still fails possibleRealData', async (name, isLeak) => {
  const real = await realDataResult(name);
  expect(real?.pass).toBe(false);
  expect(real?.requests.some((q) => isLeak(q))).toBe(true);
}, 90_000);

test('a hashed non-identity email under external_id still fails possibleRealData', async () => {
  const real = await realDataResult('stable-ids-leak');
  expect(real?.pass).toBe(false);
  expect(real?.message).toContain('not from the run identity');
}, 90_000);
