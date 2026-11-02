import { newId, type Request } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { decodeRequest, isCollectionEndpoint, matchesIgnoreList, META_CAPI_BODY_ONLY_IGNORE } from './index.ts';

const URL_OK = 'https://graph.facebook.com/v21.0/100000000000001/events?access_token=pw-fixture-access-token';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function req(over: Partial<Request> = {}): Request {
  return {
    type: 'request',
    id: newId('request'),
    runId: newId('run'),
    stepId: null,
    t: 1_800_000_000_000,
    method: 'POST',
    url: URL_OK,
    resourceType: 'fetch',
    frameUrl: 'http://localhost:3000/',
    initiator: null,
    headers: { 'content-type': 'application/json' },
    postData: null,
    outcome: 'stubbed',
    ...over,
  };
}

const events = [
  {
    event_name: 'Purchase',
    event_time: 1_800_000_000,
    event_id: 'pw-event-1',
    event_source_url: 'http://localhost:3000/thanks',
    action_source: 'website',
    user_data: { em: [HASH_A], ph: HASH_B, fbp: 'fb.1.1.2', client_user_agent: 'x' },
    custom_data: { value: 12 },
  },
  { event_name: 'PageView', user_data: { fbc: 'fb.1.1.3', external_id: HASH_B } },
];

const metaCapiHits = (r: Request) => decodeRequest(r).filter((h) => h.vendor === 'meta-capi');

test('a JSON body with two events gives two hits', () => {
  const postData = JSON.stringify({ data: events });
  expect(postData).toContain('"Purchase"');
  const hits = decodeRequest(req({ postData }));
  expect(hits.map((h) => [h.vendor, h.event, h.page])).toEqual([
    ['meta-capi', 'Purchase', 'http://localhost:3000/thanks'],
    ['meta-capi', 'PageView', null],
  ]);
  const [purchase, view] = hits;
  expect(purchase?.ids.hashes).toEqual({ em: { present: true, matchesIdentity: null }, ph: { present: true, matchesIdentity: null } });
  expect(purchase?.ids.fbp).toBe(true);
  expect(purchase?.ids.event_id).toBe(true);
  expect(purchase?.consent.ads).toBe('unknown');
  expect(purchase?.fieldsComplete).toBe(true);
  expect(purchase?.fields).toContain('user_data.em[]');
  expect(purchase?.idFields).toContain('user_data.em[]');
  expect(view?.ids.fbc).toBe(true);
  expect(Object.keys(view?.ids.hashes ?? {})).toEqual(['external_id']);
});

test('a form body with a JSON data field is decoded', () => {
  const postData = new URLSearchParams({ data: JSON.stringify([events[0]]) }).toString();
  expect(postData.startsWith('data=')).toBe(true);
  const hits = decodeRequest(req({ postData, headers: { 'content-type': 'application/x-www-form-urlencoded' } }));
  expect(hits).toHaveLength(1);
  expect(hits[0]?.event).toBe('Purchase');
  expect(hits[0]?.params.hashedEmail).toBe(HASH_A);
});

test('the access token is not a field or a param value', () => {
  const postData = JSON.stringify({ data: events, access_token: 'pw-body-token' });
  expect(URL_OK).toContain('access_token=pw-fixture-access-token');
  const hits = decodeRequest(req({ postData }));
  expect(JSON.stringify(hits)).not.toContain('pw-fixture-access-token');
  expect(JSON.stringify(hits)).not.toContain('pw-body-token');
  for (const hit of hits) expect(hit.fields).not.toContain('access_token');
});

test('params carry the hashed values that identity.hashesMatch reads', () => {
  const postData = JSON.stringify({ data: [{ event_name: 'Lead', user_data: { em: HASH_A, ph: HASH_B, fn: HASH_A, ct: HASH_B } }] });
  expect(postData).toContain('"fn"');
  const [hit] = decodeRequest(req({ postData }));
  expect(hit?.params).toMatchObject({
    hashedEmail: HASH_A,
    hashedPhone: HASH_B,
    'user_data.first_name': HASH_A,
    'user_data.city': HASH_B,
    pixelId: '100000000000001',
  });
});

test('a body that does not parse gives one hit with incomplete fields', () => {
  const postData = '{"data":[{"event_name":';
  expect(() => JSON.parse(postData)).toThrow();
  const hits = decodeRequest(req({ postData }));
  expect(hits).toHaveLength(1);
  expect(hits[0]?.vendor).toBe('meta-capi');
  expect(hits[0]?.event).toBeNull();
  expect(hits[0]?.fieldsComplete).toBe(false);
});

test('another path or host is no match', () => {
  const other = req({ url: 'https://graph.facebook.com/v21.0/100000000000001/other', postData: JSON.stringify({ data: events }) });
  expect(other.url).toContain('/other');
  expect(metaCapiHits(other)).toEqual([]);
  const elsewhere = req({ url: 'https://example.com/v21.0/100000000000001/events', postData: JSON.stringify({ data: events }) });
  expect(elsewhere.url).toContain('/events');
  expect(metaCapiHits(elsewhere)).toEqual([]);
});

test('a GET to the endpoint gives no hit but is a collection endpoint', () => {
  const get = req({ method: 'GET' });
  expect(get.method).toBe('GET');
  expect(decodeRequest(get)).toEqual([]);
  expect(isCollectionEndpoint(get)).toBe(true);
});

test('the ignore list holds the transport fields', () => {
  expect(matchesIgnoreList('event_name', META_CAPI_BODY_ONLY_IGNORE)).toBe(true);
  expect(matchesIgnoreList('user_data.em[]', META_CAPI_BODY_ONLY_IGNORE)).toBe(false);
});
