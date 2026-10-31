import { createHash } from 'node:crypto';
import { newId, type ConsentState, type ConsentValue, type HitConsent, type Hit, type Request, type Result } from '@pingwright/core';
import { decodeRequest } from '@pingwright/decoders';
import { expect, test } from 'vitest';
import { evaluate, type EvalEpoch } from './evaluate.ts';
import { parseScenario, ScenarioError } from './scenario.ts';

const runId = newId('run');
const state = (analytics: ConsentValue, ads: ConsentValue, adUserData: ConsentValue = ads): HitConsent => ({ analytics, ads, adUserData, adPersonalization: ads, raw: {} });
const unknown = state('unknown', 'unknown');
const denied = state('denied', 'denied');
const granted = state('granted', 'granted');

function hit(over: Partial<Hit> = {}): Hit {
  return {
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: 'req_none', t: 1500, vendor: 'sgtm', event: 'page_view',
    consent: unknown, ids: {}, page: 'http://localhost:3000/', transport: 'fetch', params: {}, fields: [], idFields: [], fieldsComplete: true, ...over,
  };
}

function epoch(startT: number, endT: number | null, label: EvalEpoch['label'], s: ConsentState): EvalEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', label, state: s };
}

const deniedEpochs = [epoch(0, 1000, 'undecided', unknown), epoch(1000, null, 'denied', denied)];
const grantedEpochs = [epoch(0, 1000, 'undecided', unknown), epoch(1000, null, 'granted', granted)];
const unknownEpochs = [epoch(0, null, 'undecided', unknown)];

function check(hits: Hit[], epochs: EvalEpoch[] = deniedEpochs, options = ''): Result {
  const scenario = parseScenario(`start: /\n${options}`);
  return evaluate([...epochs, ...hits], scenario).find((r) => r.expectation === 'builtin: deniedIdentifiers')!;
}

const withIds = (vendor: string, ...names: string[]) => hit({ vendor, fields: names, idFields: names });

test.each([
  ['analytics', 'uid'],
  ['analytics', 'user_id'],
  ['adsIdentity', 'external_id'],
  ['adsIdentity', 'user_data.email_address'],
  ['clientIdHash', 'clientIdHash'],
])('%s class (%s) is flagged when denied and not when granted or unknown', (_cls, name) => {
  const h = withIds('sgtm', name);
  const r = check([h]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([h.id]);
  expect(r.message).toContain(name);
  expect(check([h], grantedEpochs).pass).toBe(true);
  expect(check([h], unknownEpochs).pass).toBe(true);
});

test('a hit with no identifier passes while denied', () => {
  expect(check([hit({ fields: ['event_name'] })]).pass).toBe(true);
});

test('an sgtm hit with a granted gcs in a denied epoch is flagged', () => {
  const h = withIds('sgtm', 'uid');
  h.consent = state('granted', 'granted');
  expect(check([h]).pass).toBe(false);
});

test('a google-ads hit with gcs denied and no gcd is flagged for em through ads', () => {
  const h = withIds('google-ads', 'em');
  h.consent = state('denied', 'denied', 'unknown');
  const r = check([h], unknownEpochs);
  expect(r.pass).toBe(false);
  expect(r.message).toContain('google-ads em (ads denied)');
});

test('uid with only ads denied is not flagged, and em with only analytics denied is not flagged', () => {
  const ga4 = withIds('ga4', 'uid');
  ga4.consent = state('granted', 'denied');
  const ads = withIds('google-ads', 'em');
  ads.consent = state('denied', 'granted');
  expect(check([ga4, ads], unknownEpochs).pass).toBe(true);
});

test('cid and fbp are never flagged', () => {
  const hits = [hit({ vendor: 'ga4', fields: ['cid', 'client_id'], idFields: [] }), hit({ vendor: 'meta', fields: ['fbp', 'fbc', 'gclid'], idFields: [] })];
  expect(check(hits).pass).toBe(true);
});

test('identifierFields adds names and globs as analytics identifiers', () => {
  const h = hit({ fields: ['visitor_key', 'x_1'], idFields: [] });
  expect(check([h]).pass).toBe(true);
  expect(check([h], deniedEpochs, 'options: { identifierFields: [visitor_key] }').pass).toBe(false);
  expect(check([h], deniedEpochs, 'options: { identifierFields: ["x_*"] }').message).toContain('x_1 (analytics denied)');
  expect(check([h], grantedEpochs, 'options: { identifierFields: [visitor_key] }').pass).toBe(true);
});

test('identifierFields must be a non-empty list of names', () => {
  for (const v of ['[]', 'user', '[1]', '[""]']) expect(() => parseScenario(`start: /\noptions: { identifierFields: ${v} }`)).toThrow(ScenarioError);
});

test('warn severity is kept on a failed result', () => {
  const r = check([withIds('sgtm', 'uid')], deniedEpochs, 'options: { builtins: { deniedIdentifiers: warn } }');
  expect(r.pass).toBe(false);
  expect(r.severity).toBe('warn');
  expect(check([withIds('sgtm', 'uid')]).severity).toBe('fail');
});

test('a version 1 hit sent while denied cannot be evaluated', () => {
  const old: Partial<Hit> = hit();
  delete old.fields;
  delete old.idFields;
  delete old.fieldsComplete;
  const r = check([old as Hit]);
  expect(r.pass).toBe(false);
  expect(r.note).toBe('fieldsNotRecorded');
  expect(r.message).toContain('cannot evaluate: field names not recorded');
  expect(check([old as Hit], grantedEpochs).pass).toBe(true);
});

test('a denied hit with a cut body cannot be evaluated, a granted one is left alone', () => {
  const h = hit({ fieldsComplete: false, fields: [], idFields: [] });
  const r = check([h]);
  expect(r.pass).toBe(false);
  expect(r.note).toBe('cannotEvaluateBody');
  expect(r.evidence).toEqual([h.id]);
  expect(check([h], grantedEpochs).pass).toBe(true);
});

test('a leak is reported as a leak when another hit is unreadable', () => {
  const r = check([withIds('sgtm', 'uid'), hit({ fieldsComplete: false })]);
  expect(r.note).toBeUndefined();
  expect(r.message).toContain('1 more hit could not be read');
});

test('the message groups names by vendor and signal, up to five groups', () => {
  const r = check([withIds('sgtm', 'uid', 'external_id'), withIds('sgtm', 'uid'), withIds('ga4', 'uid')]);
  expect(r.message).toContain('3 hits carry identifiers while consent is denied: sgtm uid (analytics denied), sgtm external_id (adUserData denied), ga4 uid (analytics denied).');
  const many = check(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((v) => withIds(v, 'uid')));
  expect(many.message).toContain('and 2 more');
});

test('the result holds names only: no email, hash, digits or cookie value reaches the message or evidence', () => {
  const email = 'pw-fixture@example.com';
  const hash = createHash('sha256').update(email).digest('hex');
  const digits = '5550100123';
  const cookie = 'session-fake-cookie-value';
  const base = { type: 'request' as const, runId, stepId: null, t: 1500, resourceType: 'fetch', frameUrl: 'http://localhost:3000/', initiator: null, outcome: 'stubbed' as const };
  const sgtm: Request = {
    ...base, id: newId('request'), method: 'POST', url: 'https://sgtm.example.com/data?v=2&event=page_view', headers: { 'content-type': 'text/plain' },
    postData: JSON.stringify({
      event_name: 'page_view', page_location: 'http://localhost:3000/', external_id: hash, note: email, cookie_note: cookie,
      user_data: { email_address: hash, phone_number: digits }, [hash]: 'x', [digits]: 'y', [email]: 'z',
    }),
  };
  const meta: Request = {
    ...base, id: newId('request'), method: 'GET', headers: {}, postData: null,
    url: `https://www.facebook.com/tr/?id=100000000000001&ev=PageView&dl=${encodeURIComponent('http://localhost:3000/')}&ud[em]=${hash}&ud[ph]=${digits}&note=${encodeURIComponent(email)}&cookie_note=${cookie}`,
  };
  const hits = [sgtm, meta].flatMap((q) => decodeRequest(q)).map((h) => ({ ...h, t: 1500 }));
  expect(hits.map((h) => h.vendor).sort()).toEqual(['meta', 'sgtm']);
  const carried = JSON.stringify(hits.map((h) => [h.params, h.page]));
  for (const secret of [hash, digits]) expect(carried).toContain(secret);
  const scenario = parseScenario('start: /\noptions: { identifierFields: ["cookie_*"] }');
  const r = evaluate([...deniedEpochs, sgtm, meta, ...hits], scenario).find((x) => x.expectation === 'builtin: deniedIdentifiers')!;
  expect(r.pass).toBe(false);
  expect(r.message).toContain('external_id');
  const text = JSON.stringify(r);
  for (const secret of [email, hash, digits, cookie]) expect(text).not.toContain(secret);
});
