import { createHash } from 'node:crypto';
import { newId, type ConsentState, type ConsentValue, type Hit, type HitConsent, type Result } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { evaluate, type EvalEpoch } from './evaluate.ts';
import { BUILTIN_NAMES, parseScenario } from './scenario.ts';

const runId = newId('run');
const state = (analytics: ConsentValue, ads: ConsentValue, adUserData: ConsentValue = ads): HitConsent => ({ analytics, ads, adUserData, adPersonalization: ads, raw: {} });
const unknown = state('unknown', 'unknown');
const denied = state('denied', 'denied');
const granted = state('granted', 'granted');

function hit(over: Partial<Hit> = {}): Hit {
  return {
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: 'req_none', t: 500, vendor: 'meta', event: 'Purchase',
    consent: unknown, ids: {}, page: 'http://localhost:3000/', transport: 'image', params: {}, fields: [], idFields: [], fieldsComplete: true, ...over,
  };
}

function epoch(startT: number, endT: number | null, label: EvalEpoch['label'], s: ConsentState): EvalEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', label, state: s };
}

const undecidedOnly = [epoch(0, null, 'undecided', unknown)];
const grantedLater = [epoch(0, 1000, 'undecided', unknown), epoch(1000, null, 'granted', granted)];
const deniedDefault = [epoch(0, null, 'undecided', denied)];

function check(hits: Hit[], epochs: EvalEpoch[] = undecidedOnly, options = ''): Result {
  const scenario = parseScenario(`start: /\n${options}`);
  return evaluate([...epochs, ...hits], scenario).find((r) => r.expectation === 'builtin: earlyIdentifiers')!;
}

const withIds = (vendor: string, ...names: string[]) => hit({ vendor, fields: names, idFields: names });

test('earlyIdentifiers is a builtin name', () => {
  expect(BUILTIN_NAMES).toContain('earlyIdentifiers');
});

test('a Meta hit with em in the undecided epoch is flagged at warn, naming vendor, field and signal', () => {
  const h = withIds('meta', 'em', 'ph');
  expect(h.idFields).toEqual(['em', 'ph']);
  const r = check([h]);
  expect(r.pass).toBe(false);
  expect(r.severity).toBe('warn');
  expect(r.evidence).toEqual([h.id]);
  expect(r.message).toBe('1 hit carries identifiers before the consent answer: meta em, ph (ads unknown).');
});

test('earlyIdentifiers: fail makes the result fail', () => {
  const r = check([withIds('meta', 'em')], undecidedOnly, 'options: { builtins: { earlyIdentifiers: fail } }');
  expect(r.pass).toBe(false);
  expect(r.severity).toBe('fail');
});

test('the default severity of earlyIdentifiers is warn on a pass too, and no other check changes', () => {
  const scenario = parseScenario('start: /');
  const results = evaluate([...undecidedOnly, hit()], scenario);
  expect(results.find((x) => x.expectation === 'builtin: earlyIdentifiers')!.severity).toBe('warn');
  expect(results.find((x) => x.expectation === 'builtin: deniedIdentifiers')!.severity).toBe('fail');
});

test('a hit with only fbp, cid or click ids is not flagged', () => {
  const h = hit({ fields: ['fbp', 'fbc', 'cid', 'gclid'], idFields: [] });
  expect(check([h]).pass).toBe(true);
});

test('the same hit after an accept is not flagged', () => {
  const h = withIds('meta', 'em');
  h.t = 1500;
  expect(check([h], grantedLater).pass).toBe(true);
});

test('a hit with no consent epoch at all counts as before the answer', () => {
  expect(check([withIds('meta', 'em')], []).pass).toBe(false);
});

test('a denied default is left to deniedIdentifiers', () => {
  const h = withIds('meta', 'em');
  expect(deniedDefault[0]!.label).toBe('undecided');
  expect(check([h], deniedDefault).pass).toBe(true);
  const scenario = parseScenario('start: /');
  const denial = evaluate([...deniedDefault, h], scenario).find((r) => r.expectation === 'builtin: deniedIdentifiers')!;
  expect(denial.pass).toBe(false);
});

test('a Google hit that states its own denied consent is left to deniedIdentifiers, one that states granted passes', () => {
  const ads = withIds('google-ads', 'em');
  ads.consent = state('denied', 'denied', 'unknown');
  expect(check([ads]).pass).toBe(true);
  const granted = withIds('google-ads', 'em');
  granted.consent = state('granted', 'granted');
  expect(check([granted]).pass).toBe(true);
});

test('uid with only ads known (analytics unknown) is flagged by its analytics signal', () => {
  const h = withIds('ga4', 'uid');
  h.consent = state('unknown', 'granted');
  const r = check([h]);
  expect(r.pass).toBe(false);
  expect(r.message).toContain('ga4 uid (analytics unknown)');
});

test('identifierFields adds names', () => {
  const h = hit({ fields: ['visitor_key'], idFields: [] });
  expect(check([h]).pass).toBe(true);
  expect(check([h], undecidedOnly, "options: { identifierFields: ['visitor_key'] }").pass).toBe(false);
});

test('a hit before the answer with no recorded field names cannot be evaluated', () => {
  const h = hit();
  delete h.idFields;
  delete h.fields;
  const r = check([h]);
  expect(r.pass).toBe(false);
  expect(r.note).toBe('fieldsNotRecorded');
});

test('a cut body with no recorded identifier cannot be evaluated, a flagged hit is still reported', () => {
  const cut = hit({ fieldsComplete: false });
  expect(check([cut]).note).toBe('cannotEvaluateBody');
  const flagged = withIds('meta', 'em');
  const r = check([flagged, cut]);
  expect(r.note).toBeUndefined();
  expect(r.evidence).toEqual([flagged.id]);
  expect(r.message).toContain('1 more hit could not be read.');
});

test('the result holds names only: no email, hash or value reaches the message or evidence', () => {
  const email = 'pw-fixture@example.com';
  const sha = createHash('sha256').update(email).digest('hex');
  const h = withIds('meta', 'em');
  h.params = { em: sha, email };
  const text = JSON.stringify(check([h]));
  for (const secret of [email, sha]) expect(text).not.toContain(secret);
});

test('a ga4 hit before the answer with analytics unknown and ads denied: deniedIdentifiers names em, earlyIdentifiers names uid', () => {
  const h = withIds('ga4', 'em', 'uid');
  h.consent = state('unknown', 'denied');
  const early = check([h]);
  expect(early.pass).toBe(false);
  expect(early.message).toContain('ga4 uid (analytics unknown)');
  expect(early.message).not.toContain('em');
  expect(early.evidence).toEqual([h.id]);
  const denial = evaluate([...undecidedOnly, h], parseScenario('start: /')).find((r) => r.expectation === 'builtin: deniedIdentifiers')!;
  expect(denial.pass).toBe(false);
  expect(denial.message).toContain('em');
  expect(denial.message).not.toContain('uid');
  expect(denial.evidence).toEqual([h.id]);
});
