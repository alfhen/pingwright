import { createHash } from 'node:crypto';
import type { Result, RunRecords } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { buildSummary, formatSummary } from './summary.ts';

const email = 'pw-fixture@example.com';
const hash = createHash('sha256').update(email).digest('hex');
const cookie = 'session-fake-cookie-value';

test('skipped optional fields show selectors only, in the text and the JSON summary', () => {
  const records = {
    run: { id: 'run_1', site: 'https://shop.example.com/checkout' },
    hits: [],
    consentEpochs: [],
    flags: [],
    steps: [{ label: 'fill-1', skippedFields: ['#phone'], fill: { '#phone': email }, hash, cookie }],
  } as unknown as RunRecords;
  const summary = buildSummary(records, [{ expectation: 'x', pass: true, evidence: [] } as unknown as Result], 'p');
  expect(summary.skippedFields).toEqual([{ step: 'fill-1', selector: '#phone' }]);
  const text = formatSummary(summary);
  expect(text).toContain('SKIPPED FIELD #phone (not present)');
  const json = JSON.stringify(summary);
  for (const secret of [email, hash, cookie]) {
    expect(text).not.toContain(secret);
    expect(json).not.toContain(secret);
  }
});
