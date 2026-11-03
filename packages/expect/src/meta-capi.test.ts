import { createHash } from 'node:crypto';
import { createIdentity, newId, type Hit, type Request } from '@tagreeve/core';
import { decodeRequest } from '@tagreeve/decoders';
import { expect, test } from 'vitest';
import { evaluate } from './evaluate.ts';
import { parseScenario } from './scenario.ts';

const identity = createIdentity(1);
const runId = newId('run');

function capiHit(em: string | string[], more: Record<string, unknown> = {}): { hit: Hit; req: Request } {
  const req: Request = {
    type: 'request',
    id: newId('request'),
    runId,
    stepId: null,
    t: 1_800_000_000_000,
    method: 'POST',
    url: 'https://graph.facebook.com/v21.0/100000000000001/events?access_token=pw-fixture-access-token',
    resourceType: 'fetch',
    frameUrl: 'http://localhost:3000/',
    initiator: null,
    headers: { 'content-type': 'application/json' },
    postData: JSON.stringify({ data: [{ event_name: 'Purchase', event_id: 'e1', user_data: { em: Array.isArray(em) ? em : [em], ...more } }] }),
    outcome: 'stubbed',
  };
  const hits = decodeRequest(req);
  expect(hits).toHaveLength(1);
  return { hit: hits[0]!, req };
}

const run = (hits: { hit: Hit; req: Request }[], rule: string) =>
  evaluate(hits.flatMap((h) => [h.hit, h.req]), parseScenario(`start: /\nexpect:\n  must:\n    - ${rule}`), { identity })[0]!;

test('identity.hashesMatch passes a meta-capi em that is the run identity and fails one that is not', () => {
  const good = capiHit(createHash('sha256').update(identity.email).digest('hex'));
  const bad = capiHit('c'.repeat(64));
  expect(good.hit.ids.hashes?.em?.present).toBe(true);
  expect(bad.hit.ids.hashes?.em?.present).toBe(true);
  const rule = '{ vendor: meta-capi, identity.hashesMatch: true }';
  expect(run([good], rule).pass).toBe(true);
  const failed = run([good, bad], rule);
  expect(failed.pass).toBe(false);
  expect(failed.evidence).toEqual([bad.hit.id]);
  expect(run([bad], rule).pass).toBe(false);
});

const sha = (v: string) => createHash('sha256').update(v).digest('hex');

test('a matchesIdentity filter is computed from the run identity on a meta-capi hit', () => {
  const good = capiHit(sha(identity.email));
  const bad = capiHit('c'.repeat(64));
  expect(good.hit.ids.hashes?.em?.matchesIdentity).toBeNull();
  const present = '{ vendor: meta-capi, ids: { hashes.em.matchesIdentity: present } }';
  const absent = '{ vendor: meta-capi, ids: { hashes.em.matchesIdentity: absent } }';
  expect(run([good], present).pass).toBe(true);
  expect(run([good], absent).pass).toBe(false);
  expect(run([bad], present).pass).toBe(false);
  expect(run([bad], absent).pass).toBe(true);
});

test('matchesIdentity is false when any value of a multi-value em does not match', () => {
  const mixed = capiHit([sha(identity.email), 'c'.repeat(64)]);
  expect(run([mixed], '{ vendor: meta-capi, ids: { hashes.em.matchesIdentity: absent } }').pass).toBe(true);
  expect(run([mixed], '{ vendor: meta-capi, ids: { hashes.em.matchesIdentity: present } }').pass).toBe(false);
});

test('identity.hashesMatch checks every value of a multi-value em', () => {
  const rule = '{ vendor: meta-capi, identity.hashesMatch: true }';
  const good = sha(identity.email);
  expect(run([capiHit([good, good])], rule).pass).toBe(true);
  const wrong = run([capiHit([good, 'c'.repeat(64)])], rule);
  expect(wrong.pass).toBe(false);
  expect(wrong.message).toContain('hashedEmail.1');
  const raw = run([capiHit([good, identity.email])], rule);
  expect(raw.pass).toBe(false);
  expect(raw.message).toContain('unhashed email');
});

test('identity.hashesMatch fails a plain ct, zp or country on a Conversions API event', () => {
  const rule = '{ vendor: meta-capi, identity.hashesMatch: true }';
  const good = sha(identity.email);
  expect(run([capiHit(good, { ct: [sha(identity.city.toLowerCase())] })], rule).pass).toBe(true);
  const plain = run([capiHit(good, { ct: [identity.city] })], rule);
  expect(plain.pass).toBe(false);
  expect(plain.message).toContain('unhashed city');
  expect(run([capiHit(good, { zp: ['00000'] })], rule).pass).toBe(false);
});

test('identity.hashesMatch checks the second value of ct and fn', () => {
  const rule = '{ vendor: meta-capi, identity.hashesMatch: true }';
  const good = sha(identity.email);
  const city = sha(identity.city.toLowerCase());
  expect(run([capiHit(good, { ct: [city, city] })], rule).pass).toBe(true);
  expect(run([capiHit(good, { ct: [city, identity.city] })], rule).pass).toBe(false);
  expect(run([capiHit(good, { fn: [sha(identity.firstName.toLowerCase()), 'c'.repeat(64)] })], rule).pass).toBe(false);
  const filtered = run([capiHit(good, { ct: [city, identity.city] })], '{ vendor: meta-capi, ids.hashes.ct.matchesIdentity: true }');
  expect(filtered.pass).toBe(false);
});
