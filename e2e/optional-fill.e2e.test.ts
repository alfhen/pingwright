import { expect, test } from 'vitest';
import { run, runText, SANDBOX } from './cli-helpers.ts';

test('an optional fill skips a field that is not on the page and says so', async () => {
  const r = await run('optional-fill');
  expect(r.failed.filter((f) => f !== SANDBOX), r.stderr).toEqual([]);
  const step = r.records!.steps.find((s) => s.skippedFields);
  expect(step?.skippedFields).toEqual(['#phone']);
  expect(JSON.parse(r.stdout).skippedFields).toEqual([{ step: step!.label, selector: '#phone' }]);
  const text = await runText('optional-fill');
  expect(text.stdout).toContain('SKIPPED FIELD #phone (not present)');
}, 120_000);

test('the same fill without optional fails on the missing field', async () => {
  const r = await run('optional-fill-required');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('step "fill-1"');
  expect(r.records?.steps.some((s) => s.skippedFields)).not.toBe(true);
}, 120_000);
