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

test('an unlinked server container hit is not judged', () => {
  const request = { type: 'request', id: newId('request'), runId, stepId: null, t: 500, method: 'GET', url: 'https://sgtm.example.com/g/collect', resourceType: 'image', frameUrl: 'http://localhost:3000/', initiator: null, headers: {}, postData: null, outcome: 'stubbed', captured: 'serverContainer' } as const;
  const server = hit('13l3l3l3l5', { requestId: request.id });
  const find = (records: Parameters<typeof evaluate>[0]) => evaluate(records, parseScenario('start: /')).find((r) => r.expectation === 'builtin: consentModeSetup')!;
  expect(find([request, server]).pass).toBe(true);
  expect(find([hit('13l3l3l3l5')]).pass).toBe(false);
});

test('u and v letters count as a default', () => {
  const v1 = consentModeSetup([hit('13v3v3l3l5')], []);
  expect(v1.pass).toBe(false);
  expect(v1.message).toContain('without the two v2 signals');
  const full = consentModeSetup([hit('13v3v3v3v5')], []);
  expect(full.pass).toBe(true);
  expect(full.message).toContain('default set outside the dataLayer');
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

test('a google-ads hit is named by its conversion ID', () => {
  const ads = hit('13l3r3r3r5', { vendor: 'google-ads', params: { conversionId: '000000001' } });
  const r = consentModeSetup([ads], []);
  expect(r.message).toContain('Google tag AW-000000001 never set ad_storage');
});

test('the built-in warns by default and fails when the scenario says so', () => {
  const h = hit('13r3r3l3r5');
  const find = (yaml: string) => evaluate([h], parseScenario(yaml)).find((r) => r.expectation === 'builtin: consentModeSetup')!;
  const warned = find('start: /');
  expect(warned.pass).toBe(false);
  expect(warned.severity).toBe('warn');
  expect(find('start: /\noptions: { builtins: { consentModeSetup: fail } }').severity).toBe('fail');
});

test('messages name the gcd letters per tag ID, never the whole gcd', () => {
  const fail = consentModeSetup([hit('13r3r3l3l5')], []);
  expect(fail.message).toContain('Google tag G-PWTEST0001 never set ad_user_data and ad_personalization');
  expect(fail.message).toContain('(gcd letters: rrll)');
  expect(fail.message).not.toContain('13r3r3l3l5');
  const pass = consentModeSetup([hit(FULL), hit(FULL, { vendor: 'google-ads', params: { conversionId: '000000001' } })], [push('consent', 'default', {})]);
  expect(pass.message).toContain('found every signal set (gcd letters: G-PWTEST0001 rrrr; AW-000000001 rrrr)');
});

test('at most three letter sets per tag ID and five tag IDs are named', () => {
  const sets = ['13l3r3r3r5', '13r3l3r3r5', '13r3r3l3r5', '13r3r3r3l5'].map((g) => hit(g));
  expect(consentModeSetup(sets, []).message).toContain('(gcd letters: lrrr, rlrr, rrlr)');
  const tags = Array.from({ length: 6 }, (_, i) => hit('13l3r3r3r5', { params: { tid: `G-PWTEST000${i}` } }));
  const m = consentModeSetup(tags, []).message;
  expect(m).toContain('and 1 more');
  expect(m).not.toContain('G-PWTEST0005');
});

test('a page parameter tid does not name a Google Ads hit, and a non-digit conversion ID is no tag ID', () => {
  const ads = hit('13l3r3r3r5', { vendor: 'google-ads', params: { tid: 'G-PWTEST0009', conversionId: '000000001' } });
  expect(consentModeSetup([ads], []).message).toContain('Google tag AW-000000001 never set');
  const odd = hit('13l3r3r3r5', { vendor: 'google-ads', params: { conversionId: 'AB1234' } });
  expect(consentModeSetup([odd], []).message).toContain('Google tag (no tag ID) never set');
  const two = consentModeSetup([ads, hit('13l3r3r3r5', { vendor: 'google-ads', params: { conversionId: '000000002' } })], []);
  expect(two.message).toContain('AW-000000001');
  expect(two.message).toContain('AW-000000002');
});

test('hits without gcd are counted, and none at all says the setup could not be read', () => {
  const none = consentModeSetup([hit(undefined), hit(undefined)], []);
  expect(none.pass).toBe(true);
  expect(none.message).toContain('no Google hit carried gcd, so the setup could not be read');
  const some = consentModeSetup([hit(FULL), hit(undefined)], []);
  expect(some.pass).toBe(true);
  expect(some.message).toContain('1 Google hit carried no gcd');
  const failing = consentModeSetup([hit('13l3r3r3r5'), hit(undefined), hit(undefined)], []);
  expect(failing.pass).toBe(false);
  expect(failing.message).toContain('2 Google hits carried no gcd');
});
