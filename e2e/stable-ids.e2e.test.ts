import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

async function realDataResult(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
  return summary.results.find((x) => x.expectation === 'builtin: possibleRealData');
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

test('a hashed non-identity email under external_id still fails possibleRealData', async () => {
  const real = await realDataResult('stable-ids-leak');
  expect(real?.pass).toBe(false);
  expect(real?.message).toContain('not from the run identity');
}, 90_000);
