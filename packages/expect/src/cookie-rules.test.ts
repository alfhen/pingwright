import { createIdentity, newId, type Checkpoint, type ConsentState, type Request, type Response, type Step } from '@pingwright/core';
import { expect, test } from 'vitest';
import { evaluate, type EvalEpoch } from './evaluate.ts';
import { parseScenario, ScenarioError } from './scenario.ts';

const runId = newId('run');
const identity = createIdentity(1);
const unknown = { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;
const denied = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied', raw: {} } as const;

function epoch(startT: number, endT: number | null, label: EvalEpoch['label'], state: ConsentState): EvalEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', label, state };
}

const EPOCHS = [epoch(0, 1000, 'undecided', unknown), epoch(1000, null, 'denied', denied)];

function request(t: number, url = 'http://localhost:3000/session/start'): Request {
  return { type: 'request', id: newId('request'), runId, stepId: null, t, method: 'GET', url, resourceType: 'fetch', frameUrl: null, initiator: null, headers: {}, postData: null, outcome: 'passed' };
}

function response(req: Request, setCookieNames: string[]): Response {
  return { type: 'response', id: newId('response'), requestId: req.id, status: 204, setCookieNames };
}

function checkpoint(label: string, t: number | undefined, names: string[]): Checkpoint {
  return {
    type: 'checkpoint', id: newId('checkpoint'), runId, stepId: null, label, ...(t !== undefined && { t }), consentState: null,
    cookies: names.map((name) => ({ name, domain: 'localhost', expires: null, firstParty: true })),
  };
}

function step(label: string, startedAt: number, endedAt: number): Step {
  return { type: 'step', id: newId('step'), runId, index: 0, kind: 'consent', label, startedAt, endedAt, status: 'ok' } as unknown as Step;
}

function run(yaml: string, records: unknown[], networkMode: 'stub' | 'server' = 'server') {
  const runRecord = { type: 'run', id: runId, networkMode };
  return evaluate([runRecord, ...EPOCHS, ...records] as never, parseScenario(`start: /\nsteps:\n  - visit: /\n    label: go\n${yaml}`), { identity });
}

test('before: consent finds a cookie set by an early response and names the request', () => {
  const early = request(10);
  const r = run('expect:\n  mustNot:\n    - { cookie: _pwid, before: consent }', [early, response(early, ['_pwid'])])[0]!;
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([early.id]);
  expect(r.message).toContain('_pwid');
});

test('before: consent ignores a cookie set after the answer', () => {
  const late = request(1500);
  const r = run('expect:\n  mustNot:\n    - { cookie: _pwid, before: consent }', [late, response(late, ['_pwid'])])[0]!;
  expect(r.pass).toBe(true);
});

test('in epoch(denied) selects by the request time', () => {
  const early = request(10);
  const late = request(1500);
  const records = [early, response(early, ['_a']), late, response(late, ['_b'])];
  const r = run('expect:\n  mustNot:\n    - { cookie: ["_a", "_b"], in: epoch(denied) }', records)[0]!;
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([late.id]);
});

test('a glob matches the whole name', () => {
  const req = request(10);
  const records = [req, response(req, ['_ga', '_ga_PWTEST', 'xga'])];
  const r = run('expect:\n  must:\n    - { cookie: "_ga*" }', records)[0]!;
  expect(r.pass).toBe(true);
  expect(r.message).toContain('_ga, _ga_PWTEST');
  expect(r.message).not.toContain('xga');
});

test('after: <step label> keeps cookies from that step on', () => {
  const early = request(10);
  const late = request(1500);
  const rule = 'expect:\n  mustNot:\n    - { cookie: _pwid, after: go }';
  const records = [step('go', 0, 100), early, response(early, ['_pwid']), late, response(late, ['_pwid'])];
  const r = run(rule, records)[0]!;
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([late.id]);
  expect(run(rule, [step('go', 0, 2000), early, response(early, ['_pwid'])])[0]!.pass).toBe(true);
});

test('a checkpoint cookie is placed at Checkpoint.t and the message says it was present, not set', () => {
  const before = checkpoint('early', 50, ['_ga_PWTEST']);
  const after = checkpoint('late', 2000, ['_ga_PWTEST']);
  const r = run('expect:\n  mustNot:\n    - { cookie: "_ga*", before: consent }', [before, after])[0]!;
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([before.id]);
  expect(r.message).toContain('present then, not when it was set');
  expect(run('expect:\n  must:\n    - { cookie: _ga_PWTEST, in: epoch(denied) }', [before, after])[0]!.evidence).toEqual([after.id]);
});

test('a checkpoint without a time cannot be placed and never passes', () => {
  const old = checkpoint('old', undefined, ['_ga_PWTEST']);
  const r = run('expect:\n  mustNot:\n    - { cookie: _ga_PWTEST, before: consent }', [old])[0]!;
  expect(r.pass).toBe(false);
  expect(r.message).toContain('cannot evaluate');
  expect(run('expect:\n  must:\n    - { cookie: _ga_PWTEST, before: consent }', [old])[0]!.pass).toBe(false);
});

test('a rule with no time narrowing needs no checkpoint time', () => {
  expect(run('expect:\n  must:\n    - { cookie: _ga_PWTEST }', [checkpoint('old', undefined, ['_ga_PWTEST'])])[0]!.pass).toBe(true);
});

test('in stub mode a passing cookie rule says stubbed endpoints set no cookies', () => {
  const rule = 'expect:\n  mustNot:\n    - { cookie: _pwdcid, before: consent }';
  const r = run(rule, [], 'stub')[0]!;
  expect(r.pass).toBe(true);
  expect(r.note).toBe('stubNoCookies');
  expect(r.message?.endsWith('stub mode: stubbed endpoints set no cookies')).toBe(true);
  const server = run(rule, [], 'server')[0]!;
  expect(server.note).toBeUndefined();
  expect(server.message ?? "").not.toContain('stub mode');
});

test('a failing cookie rule in stub mode has no stub note', () => {
  const early = request(10);
  const r = run('expect:\n  mustNot:\n    - { cookie: _pwid, before: consent }', [early, response(early, ['_pwid'])], 'stub')[0]!;
  expect(r.pass).toBe(false);
  expect(r.note).toBeUndefined();
});

test('a cookie value shows in no result', () => {
  const FAKE_VALUE = 'pwfake-cookie-value-9f3a';
  const req = request(10);
  const res = { ...response(req, ['_pwid']), setCookie: [`_pwid=${FAKE_VALUE}`] };
  const ckp = { ...checkpoint('c', 20, ['_pwid']), cookies: [{ name: '_pwid', domain: 'localhost', expires: null, firstParty: true, value: FAKE_VALUE }] };
  const results = run('expect:\n  mustNot:\n    - { cookie: "_pw*", before: consent }\n  must:\n    - { cookie: _pwid }', [req, res, ckp]);
  expect(results.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(results)).not.toContain(FAKE_VALUE);
});

test('a cookie seen in a header and in a checkpoint cites the request only', () => {
  const req = request(10);
  const r = run('expect:\n  mustNot:\n    - { cookie: _pwid, before: consent }', [req, response(req, ['_pwid']), checkpoint('early', 50, ['_pwid'])])[0]!;
  expect(r.evidence).toEqual([req.id]);
});

test('a cookie name that looks like a value is guarded in the message', () => {
  const hashName = 'a'.repeat(40);
  const req = request(10);
  const r = run('expect:\n  mustNot:\n    - { cookie: "*" }', [req, response(req, ['_hjSession_123456789', hashName])])[0]!;
  expect(r.pass).toBe(false);
  expect(r.message).not.toContain('123456789');
  expect(r.message).not.toContain(hashName);
  expect(r.message).toContain('(other)');
});

test.each([
  ['{ cookie: x, vendor: ga4 }', 'vendor'],
  ['{ cookie: x, event: purchase }', 'event'],
  ['{ cookie: x, body.has: [email] }', 'body.has'],
  ['{ cookie: x, count: 2 }', 'count'],
  ['{ cookie: x, before: consent, in: epoch(denied) }', 'either before or in'],
  ['{ cookie: "" }', 'cookie'],
])('the cookie key in %s is a scenario error', (entry, message) => {
  const yaml = `start: /\nexpect:\n  must:\n    - ${entry}`;
  expect(() => parseScenario(yaml)).toThrow(ScenarioError);
  expect(() => parseScenario(yaml)).toThrow(message);
});

test('the cookie key takes a name, a glob or a list', () => {
  const rules = parseScenario('start: /\nexpect:\n  mustNot:\n    - { cookie: _dcid }\n    - { cookie: ["_ga*", pw_consent] }').expect.mustNot;
  expect(rules.map((r) => r.cookie)).toEqual([['_dcid'], ['_ga*', 'pw_consent']]);
});

test.each([
  ['[sgtm.example.com]', true],
  ['["*.example.com"]', true],
  ['[127.0.0.1, localhost, "::1"]', true],
  ['["*.com"]', false],
  ['["*.co.uk"]', false],
  ['[www.google-analytics.com]', false],
  ['["*.google-analytics.com"]', false],
  ['[www.facebook.com]', false],
  ['["*.google.com"]', false],
  ['[ct.pinterest.com]', false],
  ['[]', false],
  ['sgtm.example.com', false],
])('options.serverHosts %s is valid: %s', (value, valid) => {
  const yaml = `start: /\noptions:\n  serverHosts: ${value}\n`;
  if (valid) expect(parseScenario(yaml).options.serverHosts).toBeDefined();
  else expect(() => parseScenario(yaml)).toThrow(ScenarioError);
});
