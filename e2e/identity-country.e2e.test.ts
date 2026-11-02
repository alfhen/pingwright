import { expect, test } from 'vitest';
import { run, SANDBOX } from './cli-helpers.ts';

test('identity.country SE gives a Swedish phone and zip, typed into the form and not flagged', async () => {
  const r = await run('identity-country-se');
  expect(r.failed.filter((f) => f !== SANDBOX), r.stderr).toEqual([]);
  const identity = r.records!.run.identity!;
  expect(identity.country).toBe('SE');
  expect(identity.phone).toMatch(/^\+4670174\d{4}$/);
  expect(identity.zip).toMatch(/^\d{3} \d{2}$/);
  expect(r.records!.flags.filter((f) => f.kind === 'possibleRealData')).toEqual([]);
}, 90_000);

test('a country with no local format keeps US-shaped data and warns at run time', async () => {
  const r = await run('identity-country-dk');
  expect(r.records!.run.identity!.country).toBe('DK');
  expect(r.records!.run.identity!.phone).toMatch(/^\+1/);
  expect(r.stderr).toContain('identity.country DK has no local format; name, address, zip and phone are US-shaped');
}, 90_000);
