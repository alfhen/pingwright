import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

interface Summary {
  results: { expectation: string; pass: boolean; severity?: string; message: string; evidence: string[] }[];
}

async function setup(name: string) {
  const r = await run(name);
  const result = (JSON.parse(r.stdout) as Summary).results.find((x) => x.expectation === 'builtin: consentModeSetup');
  return { code: r.code, result, records: r.records! };
}

test('a hit with l for ad_user_data warns with the hit ID and exits 0', async () => {
  const { code, result, records } = await setup('consent-mode-setup');
  const hit = records.hits.find((h) => h.vendor === 'ga4' && h.consent.raw.gcd === '13r3r3l3r5');
  expect(hit).toBeDefined();
  expect(code).toBe(0);
  expect(result).toBeDefined();
  expect(result!.pass).toBe(false);
  expect(result!.severity).toBe('warn');
  expect(result!.evidence).toEqual([hit!.id]);
  expect(result!.message).toContain('Google tag G-PWTEST0001 never set ad_user_data');
  expect(result!.message).not.toContain('13r3r3l3r5');
  const text = await runText('consent-mode-setup');
  expect(text.stdout).toMatch(/WARN builtin: consentModeSetup/);
}, 150_000);

test('builtins: consentModeSetup: fail exits 1 on the same hit', async () => {
  const { code, result, records } = await setup('consent-mode-setup-fail');
  expect(records.hits.some((h) => h.vendor === 'ga4' && h.consent.raw.gcd === '13r3r3l3r5')).toBe(true);
  expect(code).toBe(1);
  expect(result!.pass).toBe(false);
  expect(result!.severity).toBe('fail');
}, 90_000);

test('a full default pushed to the dataLayer passes', async () => {
  const { code, result, records } = await setup('consent-mode-setup-full');
  expect(records.hits.some((h) => h.vendor === 'ga4' && h.consent.raw.gcd === '13r3r3r3r5')).toBe(true);
  expect(records.dataLayerEvents.some((e) => e.isConsentCommand && e.args[1] === 'default')).toBe(true);
  expect(code).toBe(0);
  expect(result!.pass).toBe(true);
  expect(result!.message).not.toContain('outside the dataLayer');
}, 90_000);

test('a full default with no dataLayer push passes and says it was set outside the dataLayer', async () => {
  const { code, result, records } = await setup('consent-mode-setup-outside');
  expect(records.dataLayerEvents.some((e) => e.isConsentCommand)).toBe(false);
  expect(code).toBe(0);
  expect(result!.pass).toBe(true);
  expect(result!.message).toContain('default set outside the dataLayer');
}, 90_000);
