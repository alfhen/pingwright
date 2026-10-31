import { createHash } from 'node:crypto';
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

test('a passing must cookie rule in stub mode has no stub note', () => {
  const req = request(10);
  const r = run('expect:\n  must:\n    - { cookie: _pwid }', [req, response(req, ['_pwid'])], 'stub')[0]!;
  expect(r.pass).toBe(true);
  expect(r.note).toBeUndefined();
  expect(r.message).not.toContain('stub mode');
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
  ['["*.co.kr"]', false],
  ['["*.myshopify.com"]', false],
  ['["*.github.io"]', false],
  ['["*.sgtm.example.co.kr"]', true],
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

test('a fake email, its SHA-256 and a cookie value show in no result when they arrive as cookie names', () => {
  const email = 'pw-fixture@example.com';
  const hash = createHash('sha256').update(email).digest('hex');
  const value = '9f3a7c1e5b2d48a0c6e1f4b7';
  const names = ['_pwid', email, hash, value];
  const req = request(10);
  const res = response(req, names);
  const ckp = checkpoint('c', 20, names);
  const results = run('expect:\n  mustNot:\n    - { cookie: "*", before: consent }\n  must:\n    - { cookie: "*" }', [req, res, ckp]);
  expect(results.length).toBeGreaterThanOrEqual(2);
  expect(results.some((r) => r.message?.includes('(other)'))).toBe(true);
  for (const secret of [email, hash, value]) {
    expect(JSON.stringify([res, ckp])).toContain(secret);
    expect(JSON.stringify(results)).not.toContain(secret);
  }
});

function stored(cookies: { name: string; domain: string }[], label: string, t: number): Checkpoint {
  return { ...checkpoint(label, t, []), cookies: cookies.map((c) => ({ ...c, expires: null, firstParty: true })) };
}

const NOT_BEFORE = 'expect:\n  mustNot:\n    - { cookie: _dcid, before: consent }';

test('a later checkpoint holding the cookie says it was stored by the browser', () => {
  const req = request(10, 'http://localhost:3000/data');
  const r = run(NOT_BEFORE, [req, response(req, ['_dcid']), stored([{ name: '_dcid', domain: 'localhost' }], 'later', 200)])[0]!;
  expect(r.pass).toBe(false);
  expect(r.message).toContain('found _dcid from Set-Cookie (1 request); stored by the browser');
  expect(r.note).toBeUndefined();
});

test('a later checkpoint without the cookie sets cookieNotStored and the rule still fails', () => {
  const reqs = Array.from({ length: 7 }, (_, i) => request(10 + i, 'http://localhost:3000/data'));
  const records = [...reqs.flatMap((q) => [q, response(q, ['_dcid'])]), stored([], 'later', 500)];
  const r = run(NOT_BEFORE, records)[0]!;
  expect(r.pass).toBe(false);
  expect(r.message).toContain('found _dcid from Set-Cookie (7 requests); no later checkpoint has it');
  expect(r.note).toBe('cookieNotStored');
});

test('no checkpoint after the response gives no storage text and no note', () => {
  const req = request(10);
  const records = [req, response(req, ['_dcid']), stored([], 'early', 5)];
  const r = run(NOT_BEFORE, records)[0]!;
  expect(r.pass).toBe(false);
  expect(r.message).not.toMatch(/stored|later checkpoint/);
  expect(r.note).toBeUndefined();
  const alone = run(NOT_BEFORE, [req, response(req, ['_dcid'])])[0]!;
  expect(alone.message).not.toMatch(/stored|later checkpoint/);
  expect(alone.note).toBeUndefined();
});

test('a cookie set with Domain=example.com by a subdomain host counts as stored', () => {
  const req = request(10, 'https://sgtm.example.com/data');
  for (const domain of ['.example.com', 'example.com', 'sgtm.example.com']) {
    const r = run(NOT_BEFORE, [req, response(req, ['_dcid']), stored([{ name: '_dcid', domain }], 'later', 200)])[0]!;
    expect(r.message).toContain('stored by the browser');
  }
});

test('a same-named cookie on another domain does not count as stored', () => {
  const req = request(10, 'https://sgtm.example.com/data');
  for (const domain of ['.other.example', 'notexample.com', 'sgtm.example.com.evil.example']) {
    const r = run(NOT_BEFORE, [req, response(req, ['_dcid']), stored([{ name: '_dcid', domain }], 'later', 200)])[0]!;
    expect(r.message).toContain('no later checkpoint has it');
    expect(r.note).toBe('cookieNotStored');
  }
});

const AT_LATER = (names: { name: string; domain: string }[]) => stored(names, 'later', 500);
const HERE = (name: string) => ({ name, domain: 'localhost' });

test('a cookie an earlier checkpoint already held reads as already set, with no storage claim and no note', () => {
  const req = request(100, 'http://localhost:3000/data');
  for (const records of [
    [stored([HERE('_dcid')], 'early', 5), req, response(req, ['_dcid'])],
    [stored([HERE('_dcid')], 'early', 5), req, response(req, ['_dcid']), AT_LATER([HERE('_dcid')])],
  ]) {
    const r = run(NOT_BEFORE, records)[0]!;
    expect(r.pass).toBe(false);
    expect(r.message).toContain('found _dcid from Set-Cookie (1 request); the cookie was already set before this response');
    expect(r.message).not.toContain('stored by the browser');
    expect(r.note).toBeUndefined();
  }
});

test('an earlier checkpoint on another domain does not make the cookie already set', () => {
  const req = request(100, 'http://localhost:3000/data');
  const r = run(NOT_BEFORE, [stored([{ name: '_dcid', domain: '.other.example' }], 'early', 5), req, response(req, ['_dcid']), AT_LATER([HERE('_dcid')])])[0]!;
  expect(r.message).toContain('stored by the browser');
});

test('a checkpoint inside the margin after the request is ignored', () => {
  const req = request(100, 'http://localhost:3000/data');
  const inside = stored([HERE('_dcid')], 'inside', 120);
  const alone = run(NOT_BEFORE, [req, response(req, ['_dcid']), inside])[0]!;
  expect(alone.message).not.toMatch(/stored|later checkpoint/);
  expect(alone.note).toBeUndefined();
  const withEmpty = run(NOT_BEFORE, [req, response(req, ['_dcid']), inside, AT_LATER([])])[0]!;
  expect(withEmpty.message).toContain('no later checkpoint has it');
});

test('request 1, a checkpoint holding the cookie, then six more requests still reads stored', () => {
  const first = request(100, 'http://localhost:3000/data');
  const rest = Array.from({ length: 6 }, (_, i) => request(300 + i, 'http://localhost:3000/data'));
  const records = [first, response(first, ['_dcid']), stored([HERE('_dcid')], 'mid', 200), ...rest.flatMap((q) => [q, response(q, ['_dcid'])]), AT_LATER([HERE('_dcid')])];
  const r = run(NOT_BEFORE, records)[0]!;
  expect(r.message).toContain('found _dcid from Set-Cookie (7 requests); stored by the browser');
  expect(r.note).toBeUndefined();
});

test('one already-set and one not-stored sighting of the same name read as not stored', () => {
  const first = request(100, 'https://sgtm.example.com/data');
  const second = request(300, 'http://localhost:3000/data');
  const early = stored([HERE('_dcid')], 'early', 200);
  const r = run(NOT_BEFORE, [first, response(first, ['_dcid']), early, second, response(second, ['_dcid']), AT_LATER([])])[0]!;
  expect(r.message).toContain('found _dcid from Set-Cookie (2 requests); no later checkpoint has it');
  expect(r.note).toBe('cookieNotStored');
});

test('one name already set and another stored gives the mixed text', () => {
  const req = request(100, 'http://localhost:3000/data');
  const rules = 'expect:\n  mustNot:\n    - { cookie: "_d*", before: consent }';
  const records = [stored([HERE('_da')], 'early', 5), req, response(req, ['_da', '_db']), AT_LATER([HERE('_da'), HERE('_db')])];
  const r = run(rules, records)[0]!;
  expect(r.message).toContain('stored by the browser: _db; the cookie was already set before this response: _da');
  expect(r.note).toBeUndefined();
});
