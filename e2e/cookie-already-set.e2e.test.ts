import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

test('a cookie that was already set is not reported as stored, and the rule still fails', async () => {
  const r = await run('cookie-already-set');
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
  const result = summary.results.find((x) => x.expectation.includes('cookie'))!;
  const records = r.records!;
  const note = records.results.find((x) => x.expectation === result.expectation)?.note;

  expect(r.code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('found _pwalready from Set-Cookie (1 request); the cookie was already set before this response');
  expect(result.message).not.toContain('stored by the browser');
  expect(note).toBeUndefined();

  const early = records.checkpoints.find((c) => c.label === 'early')!;
  expect(early.cookies.map((c) => c.name)).toContain('_pwalready');

  expect(r.stdout + r.stderr + JSON.stringify(records.results)).not.toContain('pw-fixture-cookie-value');
}, 90_000);
