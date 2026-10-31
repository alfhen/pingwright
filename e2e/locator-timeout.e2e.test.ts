import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

test('a role locator timeout lists only radios, closest name first', async () => {
  const r = await run('tiles-role-timeout');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('Closest radio controls:');
  const list = r.stderr.slice(r.stderr.indexOf('Closest radio controls:'));
  expect(list.indexOf('"Black (02)"')).toBeGreaterThan(-1);
  expect(list.indexOf('"Black (02)"')).toBeLessThan(list.indexOf('"White (01)"'));
  expect(r.stderr).not.toContain('Size guide');
  expect(r.stderr).not.toContain('Help');
}, 90_000);
