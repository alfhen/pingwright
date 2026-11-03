import { createHash } from 'node:crypto';
import { createIdentity, newId, type Hit, type Request } from '@tagreeve/core';
import { decodeRequest } from '@tagreeve/decoders';
import { expect, test } from 'vitest';
import { evaluate } from './evaluate.ts';
import { parseScenario } from './scenario.ts';

const identity = createIdentity(1);
const runId = newId('run');

function capiHit(em: string): { hit: Hit; req: Request } {
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
    postData: JSON.stringify({ data: [{ event_name: 'Purchase', event_id: 'e1', user_data: { em: [em] } }] }),
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

test('a matchesIdentity filter matches neither present nor absent on a meta-capi hit, because the decoder leaves it null', () => {
  const h = capiHit(createHash('sha256').update(identity.email).digest('hex'));
  expect(h.hit.ids.hashes?.em?.matchesIdentity).toBeNull();
  expect(run([h], '{ vendor: meta-capi, ids: { hashes.em.matchesIdentity: present } }').pass).toBe(false);
  expect(run([h], '{ vendor: meta-capi, ids: { hashes.em.matchesIdentity: absent } }').pass).toBe(false);
});
