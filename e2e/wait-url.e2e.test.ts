import { expect, test } from 'vitest';
import { ga4, run, SANDBOX } from './cli-helpers.ts';

test('wait: { url } waits for the page to reach the path', async () => {
  const r = await run('wait-url');
  expect(r.code, r.stderr).toBe(0);
  expect(r.failed.filter((f) => f !== SANDBOX)).toEqual([]);
  expect(r.records!.steps.map((s) => s.label)).toEqual(['start', 'click-1', 'wait-2', 'wait-3']);
  expect(ga4(r.records!.hits, 'purchase')).toHaveLength(1);
}, 90_000);
