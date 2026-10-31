import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

const EMAIL_HASH = createHash('sha256').update('pw-fixture@example.com').digest('hex');

async function bodyRule(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
  const result = summary.results.find((x) => x.expectation.includes('body.has'))!;
  const note = r.records!.results.find((x) => x.expectation === result.expectation)?.note;
  return { code: r.code, result, note, text: r.stdout + r.stderr + JSON.stringify(r.records!.results) };
}

test('a plain name passes on a nested email and says only nested fields match', async () => {
  const { code, result, note, text } = await bodyRule('leaf-nested-plain');
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
  expect(note).toBe('nestedNameOnly');
  expect(result.message).toContain('no top-level match; nested fields with this name: customerHashed.email');
  expect(text).not.toContain(EMAIL_HASH);
  expect(text).not.toContain('pw-fixture@example.com');
}, 90_000);

test('**.email fails on a nested email', async () => {
  const { code, result, note } = await bodyRule('leaf-nested-leaf');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('customerHashed.email');
  expect(note).toBeUndefined();
}, 90_000);

test('**.email fails on a top-level email, which a plain glob like *.email would miss', async () => {
  const { code, result } = await bodyRule('leaf-flat-leaf');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toMatch(/fields: email/);
}, 90_000);
