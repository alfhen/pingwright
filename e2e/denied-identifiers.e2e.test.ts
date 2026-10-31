import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

interface Summary {
  results: { expectation: string; pass: boolean; severity?: string; message: string; evidence: string[] }[];
}

async function denied(name: string) {
  const r = await run(name);
  const result = (JSON.parse(r.stdout) as Summary).results.find((x) => x.expectation === 'builtin: deniedIdentifiers')!;
  return { code: r.code, result, records: r.records! };
}

test('identifiers on denied GA4, Meta and server hits fail the check and name the fields', async () => {
  const { code, result, records } = await denied('identifiers-denied');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  for (const name of ['uid', 'ud[em]', 'external_id']) expect(result.message).toContain(name);
  const flagged = records.hits.filter((h) => result.evidence.includes(h.id));
  expect(flagged.map((h) => h.vendor).sort()).toEqual(['ga4', 'meta', 'sgtm']);
  expect(flagged.length).toBe(result.evidence.length);
  expect(result.message).not.toContain(records.run.identity!.email);
}, 90_000);

test('identifiers on granted hits pass the check', async () => {
  const { code, result } = await denied('identifiers-granted');
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
}, 90_000);

test('warn turns the failed check into a warning and exit 0', async () => {
  const { code, result } = await denied('identifiers-warn');
  expect(code).toBe(0);
  expect(result.pass).toBe(false);
  expect(result.severity).toBe('warn');
}, 90_000);

test('a cid-only GA4 hit and an fbp-only Meta hit pass while denied', async () => {
  const { code, result, records } = await denied('identifiers-control');
  expect(records.hits.some((h) => h.vendor === 'ga4')).toBe(true);
  expect(code).toBe(0);
  expect(result.pass).toBe(true);
}, 90_000);
