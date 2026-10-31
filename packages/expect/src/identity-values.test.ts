import { createIdentity, fieldHashes, hashEmail, hashPhone, newId, sha256, type Hit, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest } from '@pingwright/decoders';
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
  expect(check({}).message).toContain('carried no hashed email, phone, name or address value');
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
