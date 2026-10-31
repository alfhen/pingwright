import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

const NESTED_NOTE = 'a plain name matches a top-level field only; use **.name to match at any depth';

test('the text summary prints the note under the PASS line', async () => {
  const r = await runText('leaf-nested-plain');
  expect(r.code).toBe(0);
  const lines = r.stdout.split('\n');
  const at = lines.findIndex((l) => /^\s+PASS mustNot:.*body\.has/.test(l));
  expect(at).toBeGreaterThan(-1);
  expect(lines[at + 1]).toBe(`       note: ${NESTED_NOTE}`);
}, 90_000);

test('--json has the note code on the result', async () => {
  const r = await run('leaf-nested-plain');
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; note?: string }[] };
  const result = summary.results.find((x) => x.expectation.includes('body.has'))!;
  expect(result.pass).toBe(true);
  expect(result.note).toBe('nestedNameOnly');
}, 90_000);
