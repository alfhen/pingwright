import { expect, test } from 'vitest';
import { run, SANDBOX } from './cli-helpers.ts';

test('identity.country SE gives a Swedish phone and zip, typed into the form and not flagged when a hit carries them in plain text', async () => {
  const r = await run('identity-country-se');
  expect(r.failed.filter((f) => f !== SANDBOX), r.stderr).toEqual([]);
  const identity = r.records!.run.identity!;
  expect(identity.country).toBe('SE');
  expect(identity.phone).toMatch(/^\+4670174\d{4}$/);
  expect(identity.zip).toMatch(/^\d{3} \d{2}$/);
  const national = `0${identity.phone!.slice(3)}`.replace(/^(\d{3})(\d{3})(\d+)$/, '$1 $2 $3');
  const plain = r.records!.hits.find((h) => h.params['user_data.phone_number'] === national);
  expect(plain, 'a hit with the plain national phone').toBeDefined();
  expect(plain!.params['user_data.postal_code']).toBe(identity.zip);
  expect(r.records!.flags.filter((f) => f.kind === 'possibleRealData')).toEqual([]);
  expect(r.records!.hits.some((h) => h.vendor === 'sgtm' && h.event === 'purchase' && h.params['user_data.phone_number'])).toBe(true);
  const hashes = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(hashes.pass).toBe(true);
  expect(r.records!.results.find((x) => x.expectation === 'builtin: possibleRealData')!.pass).toBe(true);
}, 120_000);

test('a country with no local format keeps US-shaped data and warns at run time', async () => {
  const r = await run('identity-country-dk');
  expect(r.records!.run.identity!.country).toBe('DK');
  expect(r.records!.run.identity!.phone).toMatch(/^\+1/);
  expect(r.stderr).toContain('identity.country DK has no local format; name, address, zip and phone are US-shaped');
}, 90_000);
