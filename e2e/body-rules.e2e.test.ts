import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

interface Summary {
  results: { expectation: string; pass: boolean; message: string; evidence: string[] }[];
}

async function expectation(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as Summary;
  const result = summary.results.find((x) => x.expectation.startsWith('must'))!;
  return { code: r.code, result, failed: r.failed, records: r.records! };
}

test('mustNot body.has fails on the leaking data tag and names the fields', async () => {
  const { code, result, failed, records } = await expectation('body-has');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(failed.filter((f) => !f.startsWith('builtin:'))).toEqual([result.expectation]);
  expect(result.message).toContain('email, phone');
  expect(result.evidence.length).toBeGreaterThan(0);
  const leaking = records.hits.filter((h) => result.evidence.includes(h.id));
  expect(leaking.length).toBe(result.evidence.length);
  for (const h of leaking) expect(h.fields).toEqual(expect.arrayContaining(['email', 'phone']));
}, 90_000);

test('mustNot body.has passes on the allowlist page', async () => {
  const { code, result } = await expectation('body-has-allowlist');
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
}, 90_000);

test('body.only fails on the leaking page and passes on the allowlist page', async () => {
  const leaking = await expectation('body-only');
  expect(leaking.code).toBe(1);
  expect(leaking.result.pass).toBe(false);
  expect(leaking.result.message).toContain('has fields outside body.only: ');
  expect(leaking.result.message).toContain('email');
  const clean = await expectation('body-only-allowlist');
  expect(clean.code).toBe(0);
  expect(clean.result.pass).toBe(true);
}, 180_000);

test('a body cut at 64 KiB ends as cannot evaluate, not as a pass', async () => {
  const { result, records } = await expectation('body-has-huge');
  expect(result.pass).toBe(false);
  expect(records.results.find((x) => x.expectation === result.expectation)?.note).toBe('cannotEvaluateBody');
  expect(result.message).toContain('cannot evaluate: body not fully recorded');
  expect(records.hits.some((h) => h.vendor === 'sgtm' && h.fieldsComplete === false)).toBe(true);
}, 90_000);
