import { createIdentity, fieldHashes, hashEmail, hashPhone, newId, sha256, type Hit, type Request } from '@tagreeve/core';
import { deflateRawSync, gzipSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { decodeRequest } from '@tagreeve/decoders';
import { evaluate, findForeignData } from './evaluate.ts';
import { parseScenario } from './scenario.ts';

const runId = newId('run');
const identity = createIdentity(1);
const rule = parseScenario('start: /\nexpect:\n  must:\n    - { vendor: sgtm, event: purchase, identity.hashesMatch: true }');

function sgtmHit(userData: Record<string, string>): { hit: Hit; req: Request } {
  const dtdc = Buffer.from(JSON.stringify({ event_name: 'purchase', page_location: 'http://localhost:3000/thank-you', user_data: userData })).toString('base64');
  const req: Request = {
    type: 'request', id: newId('request'), runId, stepId: null, t: 0, method: 'GET',
    url: `https://sgtm.example.com/data?v=2&tid=G-PWTEST0001&dtdc=${encodeURIComponent(dtdc)}`,
    resourceType: 'fetch', frameUrl: null, initiator: null, headers: {}, postData: null, outcome: 'stubbed',
  };
  return { req, hit: decodeRequest(req)[0]! };
}

const check = (userData: Record<string, string>, id = identity) => {
  const { hit, req } = sgtmHit(userData);
  return evaluate([hit, req], rule, { identity: id })[0]!;
};
const good = {
  email_address: hashEmail(identity.email).hex,
  phone_number: hashPhone(identity.phone).hex,
  first_name: sha256(identity.firstName.toLowerCase()).hex,
  last_name: sha256(identity.lastName.toLowerCase()).hex,
};

test('hashesMatch reads user_data on an sgtm hit', () => {
  const ok = check(good);
  expect(ok.pass).toBe(true);
  expect(ok.message).toContain('match the run identity');
});

test('hashesMatch fails on a wrong hash in sgtm user_data, even when the email is right', () => {
  const wrong = check({ ...good, first_name: sha256('someone').hex });
  expect(wrong.pass).toBe(false);
  expect(wrong.message).toContain('do not match');
  expect(check({ ...good, email_address: hashEmail('other@example.com').hex }).pass).toBe(false);
});

test('hashesMatch fails on plain user_data and finds nothing without user_data', () => {
  expect(check({ email_address: identity.email }).message).toContain('unhashed');
  expect(check({ first_name: identity.firstName }).message).toContain('unhashed');
  expect(check({}).message).toContain('the hit carried no identity fields (no hashed or plain email, phone, name or address); matching done server side');
});

test('a literal fill value can match a name or address hash, but never an email or phone', () => {
  const withBerlin = { ...identity, extra: ['Berlin', 'other@example.com'] };
  expect(check({ ...good, city: sha256('berlin').hex }, withBerlin).pass).toBe(true);
  expect(check({ ...good, city: sha256('paris').hex }, withBerlin).pass).toBe(false);
  expect(check({ ...good, city: sha256('berlin').hex }).pass).toBe(false);
  expect(check({ email_address: hashEmail('other@example.com').hex }, withBerlin).pass).toBe(false);
});

test('plain city, postal code and country beside hashed fields do not fail hashesMatch', () => {
  const withDe = { ...identity, extra: ['DE'] };
  expect(check({ ...good, city: 'Berlin', postal_code: '10115', country: 'DE' }).pass).toBe(true);
  expect(check({ ...good, postal_code: '10115', country: 'DE' }, withDe).pass).toBe(true);
  expect(check({ ...good, postal_code: sha256('99999').hex }).pass).toBe(false);
});

test('hashes of literal fill values are not possibleRealData, and other hashes still are', () => {
  const withBerlin = { ...identity, extra: ['Berlin'] };
  const berlin = sgtmHit({ city: sha256('berlin').hex });
  expect(findForeignData([berlin.req], [berlin.hit], identity)).toHaveLength(1);
  expect(findForeignData([berlin.req], [berlin.hit], withBerlin)).toHaveLength(0);
  const email = sgtmHit({ sha256_email_address: hashEmail('other@example.com').hex });
  expect(findForeignData([email.req], [email.hit], withBerlin)).toHaveLength(1);
});

test('a possibleRealData flag from the recorder is not reported twice', () => {
  const { hit, req } = sgtmHit({ email_address: hashEmail('other@example.com').hex });
  const [leak] = findForeignData([req], [hit], identity);
  const flag = { type: 'flag' as const, id: newId('flag'), runId, kind: 'possibleRealData', recordIds: leak!.evidence, detail: leak!.detail };
  const results = evaluate([hit, req, flag], parseScenario('start: /'), { identity });
  const real = results.find((r) => r.expectation === 'builtin: possibleRealData')!;
  expect(real.pass).toBe(false);
  expect(real.message).toContain('found 1:');
});

test('fieldHashes covers hex, base64 and base64url, with and without punctuation', () => {
  const forms = fieldHashes(' São Paulo ');
  expect(forms.has(sha256('são paulo').hex)).toBe(true);
  expect(forms.has(sha256('sãopaulo').hex)).toBe(true);
  expect(forms.has(sha256('são paulo').base64url)).toBe(true);
});

test('a scenario declares identity fields and rejects unknown ones', () => {
  const s = parseScenario('start: /\nidentity:\n  phone: "+46701740620"\n  city: Berlin\n');
  expect(s.identity).toEqual({ phone: '+46701740620', city: 'Berlin' });
  expect(s.warnings).toEqual([]);
  expect(() => parseScenario('start: /\nidentity:\n  nickname: x\n')).toThrow(/unknown identity field/);
  expect(() => parseScenario('start: /\nidentity:\n  phone: 5\n')).toThrow(/non-empty string/);
  expect(parseScenario('start: /\nidentity:\n  email: real.person@gmail.com\n').warnings[0]).toContain('looks like a real email');
});

test('hashesMatch passes a decoded Meta hit with the identity hash and fails a wrong one', () => {
  const metaRule = parseScenario('start: /\nexpect:\n  must:\n    - { vendor: meta, identity.hashesMatch: true }');
  const run = (hash: string) => {
    const req: Request = {
      type: 'request', id: newId('request'), runId, stepId: null, t: 0, method: 'GET',
      url: `https://www.facebook.com/tr?id=100000000000001&ev=Purchase&ud[em]=${hash}`,
      resourceType: 'image', frameUrl: null, initiator: null, headers: {}, postData: null, outcome: 'stubbed',
    };
    const hit = decodeRequest(req)[0]!;
    expect(hit.vendor).toBe('meta');
    return evaluate([hit, req], metaRule, { identity })[0]!;
  };
  expect(run(hashEmail(identity.email).hex).pass).toBe(true);
  expect(run(hashEmail('other@example.com').hex).pass).toBe(false);
});

function rawRequest(url: string, postData: string | null = null): Request {
  return {
    type: 'request', id: newId('request'), runId, stepId: null, t: 0, method: postData ? 'POST' : 'GET', url,
    resourceType: 'fetch', frameUrl: null, initiator: null, headers: {}, postData, outcome: 'stubbed',
  };
}

test('possibleRealData names the hit parameter that carries a foreign hash', () => {
  const { hit, req } = sgtmHit({ country: sha256('fr').hex });
  const [leak] = findForeignData([req], [hit], identity);
  expect(leak!.detail).toMatch(/carries 1 hash value\(s\) that are not from the run identity, in user_data\.country$/);
  expect(leak!.detail).not.toContain(sha256('fr').hex);
});

test('possibleRealData says the URL or the body for a value no decoder read', () => {
  const foreign = hashEmail('other@example.com').hex;
  const inUrl = findForeignData([rawRequest(`https://tracker.example.com/p?x=${foreign}`)], [], identity);
  expect(inUrl[0]!.detail).toMatch(/, in the URL$/);
  const inBody = findForeignData([rawRequest('https://tracker.example.com/p', `a=1&x=${foreign}`)], [], identity);
  expect(inBody[0]!.detail).toMatch(/, in the body$/);
  expect(inUrl[0]!.detail + inBody[0]!.detail).not.toContain(foreign);
});

test('possibleRealData prints a value used as a key as (other)', () => {
  const foreign = hashEmail('other@example.com').hex;
  const { hit, req } = sgtmHit({});
  const keyed = { ...hit, params: { [`user_data.${foreign}`]: sha256('x').hex } };
  const details = findForeignData([req], [keyed], identity).map((l) => l.detail).join('\n');
  expect(details).not.toContain(foreign);
  expect(details).toContain('(other)');
});

test('hashesMatch keeps the Not matching message when the hit has fields', () => {
  const r = check({ ...good, postal_code: sha256('00000').hex });
  expect(r.message).toContain('Not matching: user_data.postal_code');
  expect(r.message).not.toContain('carried no identity fields');
});

const EMAIL = 'visitor@other-person.example';
const REPLAY = 'https://replay.tagreeve.invalid/collect';
const asRecorded = (bytes: Buffer) => bytes.toString('utf8');
const withHeaders = (postData: string, headers: Record<string, string>): Request => ({ ...rawRequest(REPLAY, postData), headers });
const randomBytes = (() => {
  const out = Buffer.alloc(300);
  let seed = 7;
  for (let i = 0; i < out.length; i++) out[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
  out.write('visitor@other-person.example', 100);
  return out;
})();

test('possibleRealData skips a gzip body with content-encoding gzip', () => {
  const body = asRecorded(gzipSync(randomBytes));
  expect(body).toContain(EMAIL);
  expect(findForeignData([withHeaders(body, { 'content-encoding': 'gzip' })], [], identity)).toHaveLength(0);
});

test('possibleRealData skips a gzip body with no headers', () => {
  const body = asRecorded(gzipSync(randomBytes));
  expect(body).toContain(EMAIL);
  expect(findForeignData([rawRequest(REPLAY, body)], [], identity)).toHaveLength(0);
});

test('possibleRealData skips a compressed body sent as text/plain', () => {
  const body = asRecorded(gzipSync(randomBytes));
  expect(body).toContain(EMAIL);
  expect(findForeignData([withHeaders(body, { 'Content-Type': 'text/plain;charset=UTF-8' })], [], identity)).toHaveLength(0);
});

test('possibleRealData skips deflate-raw and random bytes whose bytes spell an email', () => {
  const deflated = asRecorded(deflateRawSync(randomBytes));
  expect(deflated).toContain('visitor@other-person.example');
  expect(findForeignData([withHeaders(deflated, { 'content-type': 'text/plain' })], [], identity)).toHaveLength(0);
  const random = asRecorded(randomBytes);
  expect(random).toContain('visitor@other-person.example');
  expect(findForeignData([withHeaders(random, { 'content-type': 'application/json' })], [], identity)).toHaveLength(0);
});

test('possibleRealData skips a binary content-type and a non-identity content-encoding', () => {
  expect(findForeignData([withHeaders('a=visitor@other-person.example', { 'content-type': 'application/octet-stream' })], [], identity)).toHaveLength(0);
  expect(findForeignData([withHeaders('a=visitor@other-person.example', { 'Content-Encoding': 'br' })], [], identity)).toHaveLength(0);
});

test('possibleRealData still scans text subtypes that share a binary prefix', () => {
  for (const type of ['application/grpc-web-text', 'application/grpc-web+json', 'image/svg+xml']) {
    expect(findForeignData([withHeaders('a=visitor@other-person.example', { 'content-type': type })], [], identity)).toHaveLength(1);
  }
  expect(findForeignData([withHeaders('a=visitor@other-person.example', { 'content-type': 'image/png; x=1' })], [], identity)).toHaveLength(0);
});

test('possibleRealData still scans a plain body and the URL of a compressed request', () => {
  const plain = findForeignData([withHeaders('a=1&email=visitor@other-person.example', { 'content-type': 'text/plain' })], [], identity);
  expect(plain[0]!.detail).toMatch(/, in the body$/);
  expect(findForeignData([withHeaders('a=visitor@other-person.example', { 'content-encoding': 'identity' })], [], identity)).toHaveLength(1);
  const compressed = { ...rawRequest('https://replay.tagreeve.invalid/collect?e=visitor@other-person.example', asRecorded(randomBytes)), headers: { 'content-encoding': 'gzip' } };
  expect(findForeignData([compressed], [], identity)[0]!.detail).toMatch(/, in the URL$/);
});
