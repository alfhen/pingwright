import { newId, type DataLayerEvent, type Hit } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { consentModeSetup } from './consent-mode-setup.ts';
import { evaluate } from './evaluate.ts';
import { parseScenario } from './scenario.ts';

const runId = newId('run');

function hit(gcd: string | undefined, over: Partial<Hit> = {}): Hit {
  const unknown = 'unknown' as const;
  return {
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: 'req_none', t: 500, vendor: 'ga4', event: 'page_view',
    consent: { analytics: unknown, ads: unknown, adUserData: unknown, adPersonalization: unknown, raw: gcd ? { gcd } : {} },
    ids: {}, page: 'http://localhost:3000/', transport: 'image', params: { tid: 'G-PWTEST0001' }, ...over,
  };
}

function push(...args: unknown[]): DataLayerEvent {
  return { type: 'dataLayerEvent', id: newId('dataLayerEvent'), runId, stepId: null, t: 1, event: null, gtmUniqueEventId: null, args, isConsentCommand: true };
}

const FULL = '13r3r3r3r5';

test.each([
  ['ad_storage', '13l3r3r3r5'],
  ['analytics_storage', '13r3l3r3r5'],
  ['ad_user_data', '13r3r3l3r5'],
  ['ad_personalization', '13r3r3r3l5'],
])('l for %s fails and names the tag and the signal', (signal, gcd) => {
  const h = hit(gcd);
  const r = consentModeSetup([h], []);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([h.id]);
  expect(r.message).toContain('Google tag G-PWTEST0001 never set ' + signal);
  expect(r.message).toContain('https://developers.google.com/tag-platform/security/guides/consent');
  expect(r.message).not.toContain(gcd);
});

test('a v1-only default fails and says the two v2 signals are missing', () => {
  const r = consentModeSetup([hit('13r3r3l3l5')], []);
  expect(r.pass).toBe(false);
  expect(r.message).toContain('ad_user_data and ad_personalization');
  expect(r.message).toContain('without the two v2 signals');
});

test('a full default passes, and says so when no consent default was pushed', () => {
  const outside = consentModeSetup([hit(FULL)], []);
  expect(outside.pass).toBe(true);
  expect(outside.message).toContain('default set outside the dataLayer (template API, TCF or other)');
  const pushed = consentModeSetup([hit(FULL)], [push('consent', 'default', { ad_storage: 'denied' })]);
  expect(pushed.pass).toBe(true);
  expect(pushed.message).not.toContain('outside the dataLayer');
});

test('no Google hits passes', () => {
  const r = consentModeSetup([hit(undefined, { vendor: 'meta' })], []);
  expect(r.pass).toBe(true);
  expect(r.evidence).toEqual([]);
});

test('a server container hit is left to the browser hit it links to', () => {
  const via = { requestId: 'req_x', rule: 'eventId', confidence: 'exact' } as unknown as Hit['via'];
  expect(consentModeSetup([hit('13l3l3l3l5', { via })], []).pass).toBe(true);
});

test('hits are grouped per Google tag ID and an odd tid is not quoted', () => {
  const a = hit('13l3r3r3r5');
  const b = hit('13r3r3l3r5', { params: { tid: 'G-PWTEST0002' } });
  const c = hit('13r3r3r3l5', { params: { tid: 'pw-fixture-cookie-value@example.com' } });
  const r = consentModeSetup([a, b, c], []);
  expect(r.evidence).toEqual([a.id, b.id, c.id]);
  expect(r.message).toContain('Google tag G-PWTEST0001 never set ad_storage');
  expect(r.message).toContain('Google tag G-PWTEST0002 never set ad_user_data');
  expect(r.message).toContain('Google tag (no tag ID) never set ad_personalization');
  expect(r.message).not.toContain('example.com');
});

test('the built-in warns by default and fails when the scenario says so', () => {
  const h = hit('13r3r3l3r5');
  const find = (yaml: string) => evaluate([h], parseScenario(yaml)).find((r) => r.expectation === 'builtin: consentModeSetup')!;
  const warned = find('start: /');
  expect(warned.pass).toBe(false);
  expect(warned.severity).toBe('warn');
  expect(find('start: /\noptions: { builtins: { consentModeSetup: fail } }').severity).toBe('fail');
});
