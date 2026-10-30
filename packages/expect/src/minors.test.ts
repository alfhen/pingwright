import { createIdentity, newId, type Flag, type Hit, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { evaluate } from './evaluate.ts';
import { parseScenario } from './scenario.ts';

const runId = newId('run');
const identity = createIdentity(1);
const allUnknown = { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;

function request(over: Partial<Request> = {}): Request {
  return {
    type: 'request', id: newId('request'), runId, stepId: null, t: 0, method: 'GET',
    url: 'http://127.0.0.1:9000/collect', resourceType: 'image', frameUrl: 'http://localhost:3000/', initiator: null,
    headers: {}, postData: null, outcome: 'stubbed', ...over,
  };
}

function hit(over: Partial<Hit> = {}, req: Partial<Request> = {}): { hit: Hit; req: Request } {
  const r = request(req);
  return {
    req: r,
    hit: {
      type: 'hit', id: newId('hit'), runId, stepId: null, requestId: r.id, t: 0, vendor: 'ga4', event: 'page_view',
      consent: allUnknown, ids: {}, page: 'http://localhost:3000/', transport: 'image', params: {}, ...over,
    },
  };
}

function rule(yaml: string, pairs: { hit: Hit; req: Request }[]) {
  const records = pairs.flatMap((p) => [p.hit, p.req]);
  return evaluate(records, parseScenario(`start: /\n${yaml}`), { identity })[0]!;
}

const b64 = (text: string) => Buffer.from(text).toString('base64');
const builtin = (results: ReturnType<typeof evaluate>, name: string) => results.find((r) => r.expectation === `builtin: ${name}`)!;

test('host filter matches the bare hostname as well as host:port', () => {
  const a = hit({}, { url: 'http://127.0.0.1:4173/g/collect' });
  const pass = (f: string) => rule(`expect:\n  must:\n    - ${f}`, [a]).pass;
  expect(pass('{ host: 127.0.0.1 }')).toBe(true);
  expect(pass('{ host: "127.0.0.1:4173" }')).toBe(true);
  expect(pass('{ host: "127.0.0.1:9" }')).toBe(false);
  expect(pass('{ host: 127.0.0 }')).toBe(false);
});

test('bare ids.hashes means any hash present', () => {
  const some = [hit({ ids: { hashes: { em: { present: true, matchesIdentity: null } } } })];
  const none = [hit({ ids: { hashes: { em: { present: false, matchesIdentity: null } } } }), hit({ ids: {} })];
  expect(rule('expect:\n  must:\n    - { ids.hashes: present }', some).pass).toBe(true);
  expect(rule('expect:\n  mustNot:\n    - { ids.hashes: present }', some).pass).toBe(false);
  expect(rule('expect:\n  must:\n    - { ids.hashes: present }', none).pass).toBe(false);
  expect(rule('expect:\n  mustNot:\n    - { ids.hashes: present }', none).pass).toBe(true);
});

test('id lookups ignore prototype names', () => {
  const h = [hit({ ids: { client_id: true, hashes: { em: { present: true, matchesIdentity: true } } } })];
  expect(rule('expect:\n  must:\n    - { ids.constructor: present }', h).pass).toBe(false);
  expect(rule('expect:\n  must:\n    - { ids.constructor: absent }', h).pass).toBe(true);
  expect(rule('expect:\n  must:\n    - { ids.hashes.constructor: present }', h).pass).toBe(false);
  expect(rule('expect:\n  must:\n    - { ids.hashes.toString: absent }', h).pass).toBe(true);
});

test('possibleRealData lists the first five findings and counts the rest', () => {
  const pairs = Array.from({ length: 7 }, (_, i) => hit({}, { postData: b64(`user${i}@example.org`) }));
  const records = pairs.flatMap((p) => [p.hit, p.req]);
  const check = builtin(evaluate(records, parseScenario('start: /'), { identity }), 'possibleRealData');
  expect(check.pass).toBe(false);
  expect(check.message).toContain('found 7:');
  expect(check.message).toContain('; and 2 more.');
  expect(String(check.message).match(/request req_/g)?.length).toBe(5);
});

test('scenario parse rejects bad ids.hashes names and prototype var names', () => {
  const error = (text: string) => {
    try {
      parseScenario(text);
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };
  const withKey = (k: string) => `start: /\nexpect:\n  must:\n    - { ${k}: present }\n`;
  expect(error(withKey('ids.hashes'))).toBe('');
  expect(error(withKey('ids.hashes.em'))).toBe('');
  expect(error(withKey('ids.hashes.em.matchesIdentiy'))).toContain('ids.hashes');
  expect(error(withKey('ids.hashes.em.x.y'))).toContain('ids.hashes');
  expect(error('start: /{constructor}\n')).toContain('uses {constructor}');
});

test('host filter matches an IPv6 loopback with or without brackets', () => {
  const a = hit({}, { url: 'http://[::1]:4173/g/collect' });
  const pass = (f: string) => rule(`expect:\n  must:\n    - ${f}`, [a]).pass;
  expect(pass('{ host: "::1" }')).toBe(true);
  expect(pass('{ host: "[::1]" }')).toBe(true);
  expect(pass('{ host: "[::1]:4173" }')).toBe(true);
  expect(pass('{ host: "::2" }')).toBe(false);
});

test('unknownDestination names the host when the request URL was redacted whole', () => {
  const flag: Flag = { type: 'flag', id: newId('flag'), runId, kind: 'unknownDestination', recordIds: ['req_R'], detail: 'GET https://tracker.example.net/[redacted]' };
  const req = request({ id: 'req_R' as Request['id'], url: '[redacted]' });
  const r = builtin(evaluate([flag, req], parseScenario('start: /'), { identity }), 'unknownDestination');
  expect(r.message).toContain('tracker.example.net x1');
  expect(r.message).not.toContain('(unknown host)');
});
