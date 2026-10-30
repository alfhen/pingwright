import { createHash } from 'node:crypto';
import { MAX_POST_DATA, newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest } from './index.ts';
import { guardFieldName } from './fields.ts';
import { identifierClass, identifierSignal } from './identifiers.ts';

function req(url: string, over: Partial<Request> = {}): Request {
  return {
    type: 'request',
    id: newId('request'),
    runId: newId('run'),
    stepId: null,
    t: 1_800_000_000_000,
    method: 'GET',
    url,
    resourceType: 'fetch',
    frameUrl: 'http://localhost:3000/',
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
    ...over,
  };
}

const EMAIL = 'pw-fixture@example.com';
const EMAIL_HASH = createHash('sha256').update(EMAIL).digest('hex');
const post = (url: string, body: unknown) => req(url, { method: 'POST', postData: typeof body === 'string' ? body : JSON.stringify(body) });
const GA4 = 'https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1.2';

test('sgtm fields: nested names, arrays, empty values and dtdc', () => {
  const dtdc = Buffer.from(JSON.stringify({ event_name: 'purchase', page_location: 'http://localhost:3000/', extra: { deep: 'x' } })).toString('base64');
  const [hit] = decodeRequest(
    post(`https://sgtm.example.com/data?v=2&event=purchase&dtdc=${encodeURIComponent(dtdc)}&empty=`, {
      user_data: { email_address: 'a', phone_number: '' },
      items: [{ price: 1 }, { price: 2, tags: ['x'] }],
      none: null,
      list: [],
      obj: {},
      zero: 0,
      flag: false,
    }),
  );
  expect(hit?.fields).toEqual(['event', 'event_name', 'extra.deep', 'flag', 'items[].price', 'items[].tags[]', 'page_location', 'user_data.email_address', 'v', 'zero']);
  expect(hit?.fieldsComplete).toBe(true);
});

test('a batched GA4 body gives each hit only its own line plus the query', () => {
  const hits = decodeRequest(post(GA4, 'en=page_view&ep.a=1\nen=scroll&epn.b=2'));
  expect(hits).toHaveLength(2);
  expect(hits[0]?.fields).toEqual(['cid', 'ep.a', 'en', 'tid', 'v'].sort());
  expect(hits[1]?.fields).toEqual(['cid', 'epn.b', 'en', 'tid', 'v'].sort());
  expect(hits[0]?.fields).not.toContain('epn.b');
});

test('the other decoders fill fields', () => {
  const meta = decodeRequest(req('https://www.facebook.com/tr?id=100000000000001&ev=PageView&ud[em]=abc&cd[value]=1'))[0];
  expect(meta?.fields).toEqual(['cd[value]', 'ev', 'id', 'ud[em]']);
  const ads = decodeRequest(req('https://www.googleadservices.com/pagead/conversion/000000001/?label=x&value=2'))[0];
  expect(ads?.fields).toEqual(['label', 'value']);
  const ed = encodeURIComponent(JSON.stringify({ value: 1, nested: { a: 'b' } }));
  const pin = decodeRequest(req(`https://ct.pinterest.com/v3/?tid=1&event=pagevisit&ed=${ed}`))[0];
  expect(pin?.fields).toEqual(['ed.nested.a', 'ed.value', 'event', 'tid']);
});

test('a tracker-list hit fills fields from the query and the body', () => {
  const list = [{ vendor: 'example-tracker', host: 'px.example.com', paths: ['/collect'], source: 'https://example.com/docs' }];
  const [hit] = decodeRequest(post('https://px.example.com/collect?pid=1', { a: { b: 1 } }), undefined, list);
  expect(hit?.vendor).toBe('example-tracker');
  expect(hit?.fields).toEqual(['a.b', 'pid']);
  expect(hit?.fieldsComplete).toBe(true);
});

test('name segments that look like values are stored as (other)', () => {
  expect(guardFieldName('a'.repeat(65))).toBe('(other)');
  expect(guardFieldName('ab12'.repeat(8))).toBe('(other)');
  expect(guardFieldName('AbCdEfGhIjKlMnOpQrSt1234')).toBe('(other)');
  expect(guardFieldName('order_1234567')).toBe('(other)');
  expect(guardFieldName(EMAIL)).toBe('(other)');
  expect(guardFieldName(`user.${EMAIL}.x`)).toBe('(other)');
  expect(guardFieldName('user.1234567.x')).toBe('user.(other).x');
  expect(guardFieldName('items[].price')).toBe('items[].price');
  for (const kept of ['usernest_tracking_mode', 'customer_accepts_marketing', 'allow_ad_personalization_signals', 'user_data.email_address']) {
    expect(guardFieldName(kept)).toBe(kept);
  }
});

test('a body keyed by values stores (other), not the values', () => {
  const [hit] = decodeRequest(post('https://sgtm.example.com/data?v=2&event=x', { [EMAIL]: 'yes', [EMAIL_HASH]: 'yes', '5551234567': 'yes' }));
  expect(hit?.fields).toEqual(['(other)', 'event', 'v']);
});

test('a /data POST over the cap that matches only by body signature is incomplete', () => {
  const leading = '{"event_name":"page_view","page_location":"http://localhost:3000/","email":"';
  const body = (leading + 'x'.repeat(MAX_POST_DATA)).slice(0, MAX_POST_DATA);
  const [hit] = decodeRequest(post('https://sgtm.example.com/data', body));
  expect(hit?.vendor).toBe('sgtm');
  expect(hit?.fieldsComplete).toBe(false);
  expect(hit?.fields).toEqual([]);
});

test('a cut /data body without the signature keys does not match', () => {
  const body = ('{"something":"' + 'x'.repeat(MAX_POST_DATA)).slice(0, MAX_POST_DATA);
  expect(decodeRequest(post('https://shop.example.com/data', body))).toEqual([]);
});

test('fieldsComplete is false for a cut body, unparsable JSON and a net-log POST, true for a normal body', () => {
  const url = 'https://sgtm.example.com/data?v=2&event=e';
  const cut = JSON.stringify({ a: 'x'.repeat(MAX_POST_DATA) }).slice(0, MAX_POST_DATA);
  expect(decodeRequest(post(url, cut))[0]?.fieldsComplete).toBe(false);
  expect(decodeRequest(post(url, '{"a":'))[0]?.fieldsComplete).toBe(false);
  expect(decodeRequest(post(url, { a: 1 }))[0]?.fieldsComplete).toBe(true);
  expect(decodeRequest(req(GA4, { method: 'POST', postData: null, captured: 'netlog' }))[0]?.fieldsComplete).toBe(false);
  expect(decodeRequest(post(GA4, 'en=page_view'))[0]?.fieldsComplete).toBe(true);
});

test('a net-log GET keeps its whole payload in the URL and stays complete', () => {
  expect(decodeRequest(req(GA4, { postData: null, captured: 'netlog' }))[0]?.fieldsComplete).toBe(true);
});

test('idFields: a listed name, 64 hex under a neutral name, and not a 43-character slug', () => {
  const slug = 'A'.repeat(43);
  const [hit] = decodeRequest(
    post('https://sgtm.example.com/data?v=2&event=e', {
      uid: 'u1',
      neutral: EMAIL_HASH,
      slug,
      cid: '1.2',
      user_data: { email_address: slug },
      fbp: 'fb.1.2.3',
    }),
  );
  expect(hit?.idFields).toEqual(['neutral', 'uid', 'user_data.email_address']);
});

test('meta ud keys and GA4 uid are identifiers; cid and fbp are not', () => {
  const meta = decodeRequest(req('https://www.facebook.com/tr?id=100000000000001&ev=e&ud[em]=abc&external_id=z&fbp=fb.1.2.3'))[0];
  expect(meta?.idFields).toEqual(['external_id', 'ud[em]']);
  const ga4 = decodeRequest(req(`${GA4}&uid=7`))[0];
  expect(ga4?.idFields).toEqual(['uid']);
  expect(decodeRequest(req(GA4))[0]?.idFields).toEqual([]);
});

test('no value reaches fields or idFields', () => {
  const dtdc = Buffer.from(JSON.stringify({ event_name: 'e', page_location: 'http://localhost:3000/', user_data: { email_address: EMAIL_HASH } })).toString('base64');
  const hits = [
    ...decodeRequest(post('https://sgtm.example.com/data?v=2&event=e', { email: EMAIL, user_data: { email_address: EMAIL_HASH }, neutral: EMAIL_HASH, cookie_data: 'cv-fake-cookie-value' })),
    ...decodeRequest(req(`https://sgtm.example.com/data?v=2&dtdc=${encodeURIComponent(dtdc)}`)),
    ...decodeRequest(req(`https://www.facebook.com/tr?id=100000000000001&ev=e&ud[em]=${EMAIL_HASH}&em=${EMAIL}`)),
    ...decodeRequest(post(GA4, `en=e&uid=${EMAIL_HASH}&ep.token=${EMAIL_HASH}&ep.mail=${EMAIL}`)),
  ];
  expect(hits.length).toBeGreaterThan(3);
  for (const hit of hits) {
    const text = JSON.stringify([hit.fields, hit.idFields]);
    for (const secret of [EMAIL, EMAIL_HASH, 'cv-fake-cookie-value']) expect(text).not.toContain(secret);
  }
  const meta = hits.find((h) => h.vendor === 'meta');
  expect(meta?.params.hashedEmail).toBe(EMAIL_HASH);
});

test('identifier classes and signals', () => {
  expect(identifierClass('uid')).toBe('analytics');
  expect(identifierClass('ud[em]')).toBe('adsIdentity');
  expect(identifierClass('clientIdHash')).toBe('clientIdHash');
  expect(identifierClass('neutral')).toBe('analytics');
  const state = { analytics: 'granted', ads: 'denied', adUserData: 'unknown', adPersonalization: 'unknown' } as const;
  expect(identifierSignal('adsIdentity', state)).toEqual({ field: 'ads', value: 'denied' });
  expect(identifierSignal('analytics', state)).toEqual({ field: 'analytics', value: 'granted' });
  expect(identifierSignal('adsIdentity', { ...state, adUserData: 'granted' })).toEqual({ field: 'adUserData', value: 'granted' });
});
