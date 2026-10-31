import { createHash } from 'node:crypto';
import { createIdentity, newId, type ConsentState, type Hit, type Request } from '@pingwright/core';
import { decodeRequest } from '@pingwright/decoders';
import { expect, test } from 'vitest';
import { evaluate, type EvalEpoch } from './evaluate.ts';
import { parseScenario, ScenarioError } from './scenario.ts';

const runId = newId('run');
const identity = createIdentity(1);
const unknown = { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;
const denied = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied', raw: {} } as const;

function hit(over: Partial<Hit> = {}): Hit {
  return {
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: 'req_none', t: 0, vendor: 'sgtm', event: 'page_view',
    consent: unknown, ids: {}, page: 'http://localhost:3000/', transport: 'fetch', params: {}, fields: [], fieldsComplete: true, ...over,
  };
}

function epoch(startT: number, endT: number | null, label: EvalEpoch['label'], state: ConsentState): EvalEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', label, state };
}

const EPOCHS = [epoch(0, 1000, 'undecided', unknown), epoch(1000, null, 'denied', denied)];

function run(yaml: string, hits: Hit[], requests: Request[] = []) {
  return evaluate([...EPOCHS, ...hits, ...requests], parseScenario(`start: /\n${yaml}`), { identity });
}

const one = (yaml: string, hits: Hit[]) => run(yaml, hits)[0]!;

test('body.has matches a plain name', () => {
  const r = one('expect:\n  mustNot:\n    - { vendor: sgtm, body.has: [email] }', [hit({ fields: ['email', 'event_name'] })]);
  expect(r.pass).toBe(false);
  expect(r.message).toContain('email');
  expect(r.message).not.toContain('event_name');
});

test('body.has matches a dotted name and a glob', () => {
  const hits = [hit({ fields: ['user_data.email_address', 'items[].price'] })];
  expect(one('expect:\n  mustNot:\n    - { body.has: ["user_data.email_address"] }', hits).pass).toBe(false);
  expect(one('expect:\n  mustNot:\n    - { body.has: ["user_data.*"] }', hits).pass).toBe(false);
  expect(one('expect:\n  mustNot:\n    - { body.has: ["items[].price"] }', hits).pass).toBe(false);
  expect(one('expect:\n  mustNot:\n    - { body.has: ["user_data"] }', hits).pass).toBe(true);
});

test('a glob cookie* matches a field named cookie', () => {
  expect(one('expect:\n  mustNot:\n    - { body.has: ["cookie*"] }', [hit({ fields: ['cookie'] })]).pass).toBe(false);
  expect(one('expect:\n  mustNot:\n    - { body.has: ["cookie*"] }', [hit({ fields: ['cookie_data'] })]).pass).toBe(false);
  expect(one('expect:\n  mustNot:\n    - { body.has: ["cookie*"] }', [hit({ fields: ['my_cookie'] })]).pass).toBe(true);
});

test('body.has can be written nested', () => {
  const rule = parseScenario('start: /\nexpect:\n  mustNot:\n    - { body: { has: [email] } }').expect.mustNot[0]!;
  expect(rule.body).toEqual({ has: ['email'] });
});

test('mustNot body.has in an epoch ignores hits in other epochs', () => {
  const early = hit({ t: 10, fields: ['email'] });
  const late = hit({ t: 1500, fields: ['email'] });
  const yaml = 'expect:\n  mustNot:\n    - { body.has: [email], in: epoch(denied) }';
  const r = one(yaml, [early, late]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([late.id]);
  expect(one(yaml, [early]).pass).toBe(true);
});

test('must body.has passes when enough hits have the field', () => {
  const yaml = 'expect:\n  must:\n    - { body.has: [page_title], count: ">=2" }';
  expect(one(yaml, [hit({ fields: ['page_title'] }), hit({ fields: ['page_title'] })]).pass).toBe(true);
  expect(one(yaml, [hit({ fields: ['page_title'] }), hit({ fields: ['other'] })]).pass).toBe(false);
});

test('body.only fails when one of two selected hits has an outside field', () => {
  const clean = hit({ fields: ['event_name', 'page_location'] });
  const leaking = hit({ fields: ['event_name', 'email', 'phone'] });
  const r = one('expect:\n  must:\n    - { vendor: sgtm, body.only: [event_name, page_location] }', [clean, leaking]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([leaking.id]);
  expect(r.message).toBe(`${leaking.id} has fields outside body.only: email, phone (2 of 3).`);
});

test('body.only fails in mustNot too, and passes when nothing is outside', () => {
  const leaking = hit({ fields: ['email'] });
  expect(one('expect:\n  mustNot:\n    - { body.only: [event_name] }', [leaking]).pass).toBe(false);
  expect(one('expect:\n  mustNot:\n    - { body.only: [event_name] }', [hit({ fields: ['event_name'] })]).pass).toBe(true);
});

test('body.only under must fails when no hit is selected', () => {
  const r = one('expect:\n  must:\n    - { vendor: ga4, body.only: [event_name] }', [hit({ fields: ['event_name'] })]);
  expect(r.pass).toBe(false);
  expect(r.message).toContain('found 0');
});

test('body.only accepts globs and the vendor ignore list, and body.ignore adds names', () => {
  const sgtm = hit({ fields: ['v', 'tid', 'event', 'en', 'dtdc', 'event_name', 'extra_1'] });
  const yaml = (extra: string) => `expect:\n  must:\n    - { vendor: sgtm, body.only: [event_name, "extra_*"]${extra} }`;
  expect(one(yaml(''), [sgtm]).pass).toBe(true);
  const unlisted = hit({ fields: ['event_name', 'debug_id'] });
  expect(one(yaml(''), [unlisted]).pass).toBe(false);
  expect(one(yaml(', body.ignore: [debug_id]'), [unlisted]).pass).toBe(true);
  const ga4 = hit({ vendor: 'ga4', fields: ['v', 'tid', 'gcs', 'cid', 'en', 'dt'] });
  expect(one('expect:\n  must:\n    - { vendor: ga4, body.only: [x] }', [ga4]).pass).toBe(true);
});

test('fields undefined fails a must and does not pass a mustNot', () => {
  const v1 = hit({ fields: undefined, fieldsComplete: undefined });
  const must = one('expect:\n  must:\n    - { body.has: [email] }', [v1]);
  expect(must.pass).toBe(false);
  expect(must.note).toBe('fieldsNotRecorded');
  expect(must.message).toContain('cannot evaluate: field names not recorded');
  const not = one('expect:\n  mustNot:\n    - { body.has: [email] }', [v1]);
  expect(not.pass).toBe(false);
  expect(not.note).toBe('fieldsNotRecorded');
  const only = one('expect:\n  must:\n    - { body.only: [email] }', [v1]);
  expect(only.pass).toBe(false);
  expect(only.note).toBe('fieldsNotRecorded');
});

test('a selected hit with a cut body does not pass mustNot body.has, must body.has or body.only', () => {
  const cut = hit({ fields: ['event_name'], fieldsComplete: false });
  for (const yaml of [
    'expect:\n  mustNot:\n    - { body.has: [email] }',
    'expect:\n  must:\n    - { body.has: [email] }',
    'expect:\n  must:\n    - { body.only: [event_name] }',
    'expect:\n  mustNot:\n    - { body.only: [event_name] }',
  ]) {
    const r = one(yaml, [cut]);
    expect(r.pass, yaml).toBe(false);
    expect(r.note, yaml).toBe('cannotEvaluateBody');
    expect(r.message, yaml).toContain('cannot evaluate: body not fully recorded');
  }
});

test('a cut body that already shows a listed field is a plain failure', () => {
  const cut = hit({ fields: ['email'], fieldsComplete: false });
  const r = one('expect:\n  mustNot:\n    - { body.has: [email] }', [cut]);
  expect(r.pass).toBe(false);
  expect(r.note).toBeUndefined();
  expect(r.message).toContain('email');
});

test('an exact count with cut hits cannot be evaluated when the cut hits could change the count', () => {
  const cut = () => hit({ fieldsComplete: false });
  const yaml = 'expect:\n  must:\n    - { body.has: [email], count: 2 }';
  const r = one(yaml, [hit({ fields: ['email'] }), cut(), cut()]);
  expect(r.pass).toBe(false);
  expect(r.note).toBe('cannotEvaluateBody');
  expect(one(yaml, [hit({ fields: ['email'] }), hit({ fields: ['email'] }), cut()]).note).toBe('cannotEvaluateBody');
  expect(one(yaml, [hit({ fields: ['email'] }), hit({ fields: ['email'] })]).pass).toBe(true);
});

test('must body.has passes on a readable match even when another hit is cut', () => {
  const r = one('expect:\n  must:\n    - { body.has: [email] }', [hit({ fields: ['email'] }), hit({ fieldsComplete: false })]);
  expect(r.pass).toBe(true);
});

test('hits outside the other filters are not selected, so a cut one there is ignored', () => {
  const r = one('expect:\n  mustNot:\n    - { vendor: ga4, body.has: [email] }', [hit({ vendor: 'sgtm', fieldsComplete: false })]);
  expect(r.pass).toBe(true);
});

test('a rule without body keys never reads fields', () => {
  const r = one('expect:\n  must:\n    - { vendor: sgtm }', [hit({ fields: undefined, fieldsComplete: undefined })]);
  expect(r.pass).toBe(true);
  expect(r.note).toBeUndefined();
});

const issues = (yaml: string) => {
  try {
    parseScenario(`start: /\n${yaml}`);
  } catch (e) {
    if (e instanceof ScenarioError) return e.issues.join('\n');
    throw e;
  }
  return '';
};

test('the parser rejects bad body shapes with a line number', () => {
  expect(issues('expect:\n  mustNot:\n    - { body.has: email }')).toMatch(/^line 4: .*body\.has: must be a non-empty list/);
  expect(issues('expect:\n  mustNot:\n    - { body.has: [] }')).toContain('non-empty list');
  expect(issues('expect:\n  mustNot:\n    - { body.has: [""] }')).toContain('non-empty list');
  expect(issues(`expect:\n  mustNot:\n    - { body.has: ["${'a'.repeat(65)}"] }`)).toContain('at most 64 characters');
  expect(issues('expect:\n  must:\n    - { body.has: [a], body.only: [b] }')).toContain('cannot be in the same entry');
  expect(issues('expect:\n  must:\n    - { vendor: meta, identity.hashesMatch: true, body.has: [a] }')).toContain('identity.hashesMatch cannot be combined');
  expect(issues('expect:\n  must:\n    - { vendor: meta, identity.hashesMatch: true, body.only: [a] }')).toContain('identity.hashesMatch cannot be combined');
  expect(issues('expect:\n  must:\n    - { body.ignore: [a] }')).toContain('only valid with body.only');
  expect(issues('expect:\n  must:\n    - { body.nope: [a] }')).toContain('unknown key');
  expect(issues('expect:\n  must:\n    - { body.has: [a] }')).toBe('');
  expect(issues(`expect:\n  must:\n    - { body.only: ["${'a'.repeat(64)}"], body.ignore: [b] }`)).toBe('');
});

test('messages and evidence hold field names, never values', () => {
  const email = 'pw-fixture@example.com';
  const hash = createHash('sha256').update(email).digest('hex');
  const cookie = 'pwfakecookievalue123';
  const body = JSON.stringify({ event_name: 'page_view', page_location: 'http://localhost:3000/', email, phone: '+15550100', cookie_data: cookie, clientIdHash: hash });
  const req: Request = {
    type: 'request', id: newId('request'), runId, stepId: null, t: 1500, method: 'POST',
    url: 'https://sgtm.example.com/data?v=2&event=page_view', resourceType: 'fetch', frameUrl: 'http://localhost:3000/', initiator: null,
    headers: { 'content-type': 'text/plain' }, postData: body, outcome: 'stubbed',
  };
  const hits = decodeRequest(req).map((h) => ({ ...h, t: 1500 }));
  expect(hits.length).toBe(1);
  expect(hits[0]!.fields).toEqual(expect.arrayContaining(['email', 'phone', 'cookie_data', 'clientIdHash']));
  const results = [
    ...run('expect:\n  mustNot:\n    - { vendor: sgtm, body.has: [email, phone, "cookie*", clientIdHash], in: epoch(denied) }', hits, [req]),
    ...run('expect:\n  must:\n    - { vendor: sgtm, body.only: [event_name, page_location] }', hits, [req]),
  ].filter((r) => r.expectation.startsWith('must'));
  expect(results.map((r) => r.pass)).toEqual([false, false]);
  expect(results[0]!.message).toContain('email, phone');
  expect(results[1]!.message).toContain('has fields outside body.only: ');
  const text = JSON.stringify(results);
  for (const value of [email, hash, cookie, '+15550100']) expect(text).not.toContain(value);
});
