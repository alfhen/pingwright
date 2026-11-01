import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

test('hashesMatch on a Meta Purchase without hashes says which condition failed', async () => {
  const r = await run('hashes-match-missing');
  const summary = JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
  const result = summary.results.find((x) => x.expectation.startsWith('must:'));
  expect(result?.pass).toBe(false);
  expect(result?.message).toContain('Expected >=1 hits matching all conditions, found 0.');
  expect(result?.message).toContain('1 hit matched vendor and event, but identity.hashesMatch failed: the hit carried no identity fields (no hashed or plain email, phone, name or address); matching done server side, for example by a conversions API, is not visible to Pingwright.');
  expect(result?.message).not.toContain('found 1 matching hit');
}, 90_000);
