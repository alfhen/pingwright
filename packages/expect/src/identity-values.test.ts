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
  expect(inBody[0]!.detail).toMatch(/, in x$/);
  const plainText = findForeignData([rawRequest('https://tracker.example.com/p', foreign)], [], identity);
  expect(plainText[0]!.detail).toMatch(/, in the body$/);
  expect(inUrl[0]!.detail + inBody[0]!.detail + plainText[0]!.detail).not.toContain(foreign);
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
  expect(plain[0]!.detail).toMatch(/, in email$/);
  expect(findForeignData([withHeaders('a=visitor@other-person.example', { 'content-encoding': 'identity' })], [], identity)).toHaveLength(1);
  const compressed = { ...rawRequest('https://replay.tagreeve.invalid/collect?e=visitor@other-person.example', asRecorded(randomBytes)), headers: { 'content-encoding': 'gzip' } };
  expect(findForeignData([compressed], [], identity)[0]!.detail).toMatch(/, in the URL$/);
});

const FOREIGN_HASH = hashEmail('other@example.com').hex;
const MULTIPART = { 'content-type': 'multipart/form-data; boundary=XB' };
const part = (name: string, body: string, extra = '') => `--XB\r\nContent-Disposition: form-data; name="${name}"${extra}\r\n\r\n${body}\r\n`;
const detailsOf = (request: Request) => findForeignData([request], [], identity).map((l) => l.detail);

test('possibleRealData names the JSON path of a foreign hash', () => {
  const body = JSON.stringify({ event: 'view', customerHashed: { country: FOREIGN_HASH } });
  expect(body).toContain(FOREIGN_HASH);
  const [detail] = detailsOf(withHeaders(body, { 'content-type': 'application/json' }));
  expect(detail).toMatch(/in customerHashed\.country$/);
  expect(detail).not.toContain(FOREIGN_HASH);
});

test('possibleRealData prints a value-like path segment of a JSON body as (other)', () => {
  const body = JSON.stringify({ [FOREIGN_HASH]: { country: 'x' }, ok: { v: FOREIGN_HASH } });
  expect(body).toContain(FOREIGN_HASH);
  const details = detailsOf(rawRequest(REPLAY, body)).join('\n');
  expect(details).toMatch(/in \(other\)\.country, ok\.v$/);
  expect(details).not.toContain(FOREIGN_HASH);
});

test('possibleRealData names the key of a form body and finds a key that is the email', () => {
  const form = `a=1&hashed_country=${FOREIGN_HASH}`;
  expect(form).toContain(FOREIGN_HASH);
  expect(detailsOf(rawRequest(REPLAY, form))[0]).toMatch(/in hashed_country$/);
  const [detail] = detailsOf(rawRequest(REPLAY, `${EMAIL}=1`));
  expect(detail).toMatch(/carries 1 email value/);
  expect(detail).not.toContain(EMAIL);
});

test('possibleRealData scans a name-only form body and a plain-text body as one text', () => {
  expect(new URLSearchParams(EMAIL).get(EMAIL)).toBe('');
  expect(detailsOf(rawRequest(REPLAY, EMAIL))[0]).toMatch(/in the body$/);
  expect(detailsOf(withHeaders(`note ${EMAIL}`, { 'content-type': 'text/plain' }))[0]).toMatch(/in the body$/);
});

test('possibleRealData skips the binary part of a multipart body and scans its text field', () => {
  const binary = asRecorded(randomBytes);
  expect(binary).toContain(EMAIL);
  const filePart = part('file', binary, '; filename="a.bin"\r\nContent-Type: application/octet-stream');
  const body = filePart + part('contact', EMAIL) + '--XB--\r\n';
  expect(body).toContain(EMAIL);
  const details = detailsOf(withHeaders(body, MULTIPART));
  expect(details).toHaveLength(1);
  expect(details[0]).toMatch(/in contact$/);
  expect(detailsOf(withHeaders(filePart + '--XB--\r\n', MULTIPART))).toHaveLength(0);
});

test('possibleRealData scans a JSON header line and skips a compressed line after it', () => {
  const binary = asRecorded(gzipSync(randomBytes));
  const header = JSON.stringify({ contact: EMAIL });
  expect(header).toContain(EMAIL);
  expect(detailsOf(rawRequest(REPLAY, `${header}\n${binary}`))).toHaveLength(1);
  expect(detailsOf(rawRequest(REPLAY, `{"a":1}\n${binary}`))).toHaveLength(0);
});

test('possibleRealData scans a form line next to a compressed line', () => {
  const binary = asRecorded(gzipSync(randomBytes));
  const body = `contact=${EMAIL}\n${binary}`;
  expect(body).toContain(EMAIL);
  const details = detailsOf(rawRequest(REPLAY, body));
  expect(details).toHaveLength(1);
  expect(details[0]).toMatch(/in contact$/);
});

test('possibleRealData names each line of a multi-line form body by its own key', () => {
  const body = `en=page_view&ep.a=1\r\nem=${FOREIGN_HASH}&en=x`;
  expect(body).toContain(FOREIGN_HASH);
  const details = detailsOf(rawRequest(REPLAY, body));
  expect(details).toHaveLength(1);
  expect(details[0]).toMatch(/in em$/);
});

test('possibleRealData skips a text body padded with many control characters', () => {
  const body = `a=${EMAIL}${'\u0001'.repeat(40)}`;
  expect(body).toContain(EMAIL);
  expect(detailsOf(rawRequest(REPLAY, body))).toHaveLength(0);
});

test('possibleRealData skips a hash under a nested always-exempt key of a JSON body', () => {
  const body = JSON.stringify({ context: { session_id: FOREIGN_HASH }, user: { client_id: FOREIGN_HASH }, items: [{ visitor_id: FOREIGN_HASH }] });
  expect(body).toContain(FOREIGN_HASH);
  expect(detailsOf(withHeaders(body, { 'content-type': 'application/json' }))).toHaveLength(0);
});

test('possibleRealData skips a nested repeat-only ID of a JSON body sent in two requests', () => {
  const body = JSON.stringify({ user: { id: FOREIGN_HASH } });
  expect(body).toContain(FOREIGN_HASH);
  const send = () => withHeaders(body, { 'content-type': 'application/json' });
  expect(findForeignData([{ ...send(), id: newId('request') }, { ...send(), id: newId('request') }], [], identity)).toHaveLength(0);
});

test.each([
  ['a form key with brackets', 'a=1&cd[555.123.4567]=1'],
  ['a form key of dotted digits', '555.123.4567=1'],
  ['a plain-text body read as a form', 'note 555.123.4567=yes'],
])('possibleRealData does not print a phone number split in %s', (_name, body) => {
  expect(body).toContain('555');
  const leaks = findForeignData([rawRequest(REPLAY, body)], [], identity);
  expect(leaks.length).toBeGreaterThan(0);
  const detail = leaks.map((l) => l.detail).join('\n');
  for (const group of ['555', '123', '4567']) expect(detail).not.toContain(group);
});

test('possibleRealData does not print a multipart part named with a phone number', () => {
  const body = ['--b', 'Content-Disposition: form-data; name="555.123.4567"', '', 'x', '--b--', ''].join('\r\n');
  const leaks = findForeignData([withHeaders(body, { 'content-type': 'multipart/form-data; boundary=b' })], [], identity);
  expect(leaks.length).toBeGreaterThan(0);
  const detail = leaks.map((l) => l.detail).join('\n');
  for (const group of ['555', '123', '4567']) expect(detail).not.toContain(group);
});

const PHONE_TEXT = '(555) 123.4567';
const mpPart = (name: string) => ['--b', `Content-Disposition: form-data; name="${name}"`, '', 'x', '--b--', ''].join('\r\n');
test.each([
  ['form name with spaces and parens', `${PHONE_TEXT}=x`, {}],
  ['form name after another field', 'x=1&+1 (555) 123.4567=y', {}],
  ['form name percent-encoded', '(555)%20123.4567=x', {}],
  ['multipart part name', mpPart(PHONE_TEXT), { 'content-type': 'multipart/form-data; boundary=b' }],
])('possibleRealData prints no digit of a phone used as a name: %s', (_n, body, headers) => {
  expect(body).toContain('4567');
  const detail = findForeignData([withHeaders(body, headers)], [], identity).map((l) => l.detail).join('\n');
  expect(detail).not.toBe('');
  for (const digits of ['4567', '123', '555']) expect(detail).not.toContain(digits);
});

test.each([
  ['a filename', `--XB\r\nContent-Disposition: form-data; name="f"; filename="${EMAIL}.txt"\r\n\r\nx\r\n--XB--\r\n`],
  ['an epilogue', `${part('a', 'x')}--XB--\r\nem=${EMAIL}\r\n`],
  ['a preamble', `see ${EMAIL}\r\n${part('a', 'x')}--XB--\r\n`],
  ['a part header', `--XB\r\nContent-Disposition: form-data; name="f"\r\nX-Note: ${EMAIL}\r\n\r\nx\r\n--XB--\r\n`],
])('possibleRealData still finds a value in %s of a multipart body', (_n, body) => {
  expect(body).toContain(EMAIL);
  const details = detailsOf(withHeaders(body, MULTIPART));
  expect(details).toHaveLength(1);
  expect(details[0]).toMatch(/in the body$/);
  expect(details[0]).not.toContain(EMAIL);
});

const FFFD = '�';
test.each([
  ['a phone split by a line break', 'Call (555)\n123-4567 please', '4567'],
  ['a phone split over four lines', 'tel\n555\n123\n4567\nend', '4567'],
  ['a short text line with stray replacement characters', `${'a=b&'.repeat(80)}\ncontact=visitor@other-person.example${FFFD.repeat(4)}`, 'visitor@other-person.example'],
  ['a hash on a line with control characters', `${'x'.repeat(300)}\nem=${FOREIGN_HASH}${'\u0001'.repeat(10)}`, FOREIGN_HASH],
])('possibleRealData still finds a value in the whole body: %s', (_n, body, value) => {
  expect(body).toContain(value);
  expect(findForeignData([rawRequest(REPLAY, body)], [], identity).length).toBeGreaterThan(0);
});

test('possibleRealData reports a form-encoded +cc+nn phone once, in its field', () => {
  const [leak] = findForeignData([rawRequest(REPLAY, 'a=1&p=+1+555+123+4567')], [], identity);
  expect(leak!.detail).toContain('carries 1 phone value(s)');
  expect(leak!.detail).toMatch(/in p$/);
});

test.each([
  ['a JSON newline escape', JSON.stringify({ e: 'line\nvisitor@other-person.example' }), 'e'],
  ['a JSON unicode escape', '{"e":"\\u00e9visitor@other-person.example"}', 'e'],
  ['a tab escape in an NDJSON line', '{"a":"x\\tvisitor@other-person.example"}\n{"b":1}', 'a'],
  ['a [] joined into the name', 'x[]visitor@other-person.example=1', '(other)'],
])('possibleRealData reports one value once when the body and its field read it with different edges: %s', (_n, body, where) => {
  expect(body).toContain('visitor@other-person.example');
  const [leak, ...rest] = findForeignData([rawRequest(REPLAY, body)], [], identity);
  expect(rest).toHaveLength(0);
  expect(leak!.detail).toContain('carries 1 email value(s)');
  expect(leak!.detail.endsWith(`in ${where}`)).toBe(true);
  expect(leak!.detail).not.toContain('other-person');
});

test('possibleRealData still counts two different emails in the body and a field', () => {
  const body = 'note=x&e=visitor@other-person.example\nsecond@another-person.example';
  expect(body).toContain('second@another-person.example');
  const [leak] = findForeignData([rawRequest(REPLAY, body)], [], identity);
  expect(leak!.detail).toContain('carries 2 email value(s)');
});

test.each(['xxxxxxxxxxxx[]555-123-4567', '555-123-4567[]xxxxxxxxxxxx'])('possibleRealData does not print the name %s', (name) => {
  for (const body of [`${name}=visitor@other-person.example`, JSON.stringify({ [name]: 'visitor@other-person.example' })]) {
    const details = findForeignData([rawRequest(REPLAY, body)], [], identity).map((l) => l.detail).join('\n');
    expect(details).not.toBe('');
    expect(details).not.toMatch(/\d{3}-\d{3}/);
  }
});
