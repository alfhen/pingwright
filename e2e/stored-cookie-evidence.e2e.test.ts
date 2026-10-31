import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

async function cookieRule(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
  const result = summary.results.find((x) => x.expectation.includes('cookie'))!;
  const note = r.records!.results.find((x) => x.expectation === result.expectation)?.note;
  return { code: r.code, result, note, text: r.stdout + r.stderr + JSON.stringify(r.records!.results) };
}

test('a cookie the browser rejects is reported as not stored, and the rule still fails', async () => {
  const { code, result, note, text } = await cookieRule('cookie-unstored');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('found _pwunstored from Set-Cookie (1 request); no later checkpoint has it');
  expect(note).toBe('cookieNotStored');
  expect(text).not.toContain('pw-fixture-cookie-value');
}, 90_000);

test('a cookie the browser keeps is reported as stored', async () => {
  const { code, result, note } = await cookieRule('cookie-stored');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('from Set-Cookie (1 request); stored by the browser');
  expect(note).toBeUndefined();
}, 90_000);
