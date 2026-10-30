import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, isCollectionEndpoint } from './index.ts';

const PAGE = 'http://localhost:3000/products/fake-tee';
const HOST = 'http://127.0.0.1:4000';

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
    frameUrl: PAGE,
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
    ...over,
  };
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const urlSafe = (s: string) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const disguised = (real: string, encode = b64) => req(`${HOST}/pwstape?pk=${encodeURIComponent(encode(real))}`);
const dtdc = (o: object) => b64(JSON.stringify(o));

test('decodes a disguised /g/collect through the GA4 decoder', () => {
  const r = disguised(
    `/g/collect?v=2&tid=G-PWTEST0001&cid=1111111111.2222222222&en=page_view&dl=${encodeURIComponent(PAGE)}`,
  );
  expect(isCollectionEndpoint(r)).toBe(true);
  const hits = decodeRequest(r);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    vendor: 'ga4',
    event: 'page_view',
    page: PAGE,
    transport: 'fetch via stape-loader',
    requestId: r.id,
    params: { tid: 'G-PWTEST0001' },
  });
});

test('decodes a disguised /data with a dtdc payload', () => {
  const payload = dtdc({ page_location: PAGE, page_hostname: 'localhost' });
  const r = disguised(
    `/data?v=2&tid=G-PWTEST0001&cid=1111111111.2222222222&event=purchase&dtdc=${encodeURIComponent(payload)}`,
  );
  expect(isCollectionEndpoint(r)).toBe(true);
  const [hit, ...rest] = decodeRequest(r);
  expect(rest).toEqual([]);
  expect(hit).toMatchObject({
    vendor: 'sgtm',
    event: 'purchase',
    page: PAGE,
    transport: 'fetch via stape-loader',
    ids: { client_id: true },
    params: { tid: 'G-PWTEST0001', page_hostname: 'localhost' },
  });
});

test('reads the /data event from dtdc event_name when the query has none', () => {
  const payload = dtdc({ event_name: 'add_to_cart', page_location: PAGE, page_hostname: 'localhost' });
  const r = disguised(`/data?v=2&tid=G-PWTEST0001&cid=1111111111.2222222222&dtdc=${encodeURIComponent(payload)}`);
  expect(decodeRequest(r)[0]).toMatchObject({ vendor: 'sgtm', event: 'add_to_cart', page: PAGE });
});

test('a fixture-shaped /data without any event name decodes with event null', () => {
  const payload = dtdc({ page_location: PAGE, page_hostname: 'localhost' });
  const r = disguised(`/data?v=2&tid=G-PWTEST0001&cid=1111111111.2222222222&dtdc=${encodeURIComponent(payload)}`);
  expect(decodeRequest(r)[0]).toMatchObject({ vendor: 'sgtm', event: null, page: PAGE });
});

test('reads consent from gcs on /data', () => {
  const payload = encodeURIComponent(dtdc({ page_location: PAGE, page_hostname: 'localhost' }));
  const [denied] = decodeRequest(req(`${HOST}/data?en=page_view&gcs=G100&dtdc=${payload}`));
  expect(denied?.consent).toMatchObject({ ads: 'denied', analytics: 'denied' });
  const [granted] = decodeRequest(req(`${HOST}/data?en=page_view&gcs=G111&dtdc=${payload}`));
  expect(granted?.consent).toMatchObject({ ads: 'granted', analytics: 'granted' });
  expect(granted?.transport).toBe('fetch');
});

test('a disguised /gtag/js is not a collection endpoint and makes no hit', () => {
  const r = disguised('/gtag/js?id=G-PWTEST0001');
  expect(isCollectionEndpoint(r)).toBe(false);
  expect(decodeRequest(r)).toEqual([]);
});

test('decodes url-safe base64 without padding', () => {
  const real = '/g/collect?v=2&tid=G-PWTEST0001&en=view_item&x=??>>';
  expect(b64(real)).toMatch(/[+/]/);
  const [hit] = decodeRequest(disguised(real, urlSafe));
  expect(hit).toMatchObject({ vendor: 'ga4', event: 'view_item' });
});

test('decodes standard base64 with a raw plus sign in the query', () => {
  const real = '/g/collect?v=2&tid=G-PWTEST0001&en=view_item&x=??>>';
  const raw = b64(real);
  expect(raw).toContain('+');
  const [hit] = decodeRequest(req(`${HOST}/pwstape?pk=${raw}`));
  expect(hit?.event).toBe('view_item');
});

test.each([
  ['a token that is not a path', `${HOST}/app?token=${b64('hello world')}`],
  ['plain text values', `${HOST}/app?a=hello&b=world`],
  ['two values that decode to paths', `${HOST}/pwstape?a=${b64('/g/collect?v=2')}&b=${b64('/data?dtdc=e30')}`],
  ['a multi-segment path', `${HOST}/a/b?pk=${b64('/g/collect?v=2&tid=G-PWTEST0001')}`],
  ['binary that decodes to junk', `${HOST}/app?pk=${Buffer.from([0x2f, 0xff, 0xfe, 0x00]).toString('base64')}`],
  ['a decoded protocol-relative url', `${HOST}/app?pk=${b64('//evil.example.com/g/collect?v=2')}`],
])('does not match %s', (_name, url) => {
  const r = req(url);
  expect(decodeRequest(r)).toEqual([]);
  expect(isCollectionEndpoint(r)).toBe(false);
});

test('a plain /data without dtdc is not a hit', () => {
  expect(decodeRequest(req(`${HOST}/data?x=1`))).toEqual([]);
});

test('/data without dtdc is a collection endpoint through the loader', () => {
  const direct = req(`${HOST}/data?tid=G-PWTEST0001&cid=1111111111.2222222222`);
  expect(isCollectionEndpoint(direct)).toBe(false);
  const wrapped = disguised('/data?tid=G-PWTEST0001&cid=1111111111.2222222222&event=purchase');
  expect(isCollectionEndpoint(wrapped)).toBe(true);
  expect(decodeRequest(wrapped)[0]).toMatchObject({ vendor: 'sgtm', event: 'purchase' });
});

test('/data with v and event parameters is a collection endpoint', () => {
  const r = req(`${HOST}/data?v=2&event=purchase&tid=G-PWTEST0001`);
  expect(isCollectionEndpoint(r)).toBe(true);
  expect(decodeRequest(r)[0]).toMatchObject({ vendor: 'sgtm', event: 'purchase' });
});

test('/data?dtdc= with a non-base64 or non-object value is not a hit', () => {
  for (const v of ['x', 'not*base64!', b64('plain text'), b64('[1]'), b64('{}')]) {
    const r = req(`https://shop.example.com/data?dtdc=${encodeURIComponent(v)}`);
    expect(decodeRequest(r)).toEqual([]);
    expect(isCollectionEndpoint(r)).toBe(false);
  }
});

test('a Stape data-client POST through the loader is stubbed and decoded (#46 field test)', () => {
  const r = req(`${HOST}/pwstape?pk=${encodeURIComponent(b64('/data?v=2&event=page_viewed'))}`, {
    method: 'POST',
    postData: JSON.stringify({ page_location: PAGE }),
  });
  expect(isCollectionEndpoint(r)).toBe(true);
  expect(decodeRequest(r)[0]).toMatchObject({
    vendor: 'sgtm',
    event: 'page_viewed',
    page: PAGE,
    transport: 'fetch via stape-loader',
  });
});

test('reads event and page from a JSON POST body on /data', () => {
  const r = req(`${HOST}/data`, {
    method: 'POST',
    postData: JSON.stringify({ event_name: 'purchase', page_location: PAGE, page_hostname: 'localhost' }),
  });
  expect(isCollectionEndpoint(r)).toBe(true);
  expect(decodeRequest(r)[0]).toMatchObject({
    vendor: 'sgtm',
    event: 'purchase',
    page: PAGE,
    params: { page_hostname: 'localhost' },
  });
});

test('a same-path /data JSON POST with only one of event_name and page_location is not a hit', () => {
  for (const body of [{ event_name: 'save' }, { page_location: PAGE }, { event_name: 'save', page_location: '' }]) {
    const r = req(`https://shop.example.com/data`, { method: 'POST', postData: JSON.stringify(body) });
    expect(decodeRequest(r)).toEqual([]);
    expect(isCollectionEndpoint(r)).toBe(false);
  }
});

test('reads user_id and client_id from a JSON POST body on /data', () => {
  const r = req(`${HOST}/data`, {
    method: 'POST',
    postData: JSON.stringify({
      event_name: 'purchase',
      page_location: PAGE,
      user_id: 'fake-user-1',
      client_id: '1111111111.2222222222',
    }),
  });
  const [hit] = decodeRequest(r);
  expect(hit!.ids).toEqual({ user_id: true, client_id: true });
  expect(JSON.stringify(hit)).not.toContain('fake-user-1');
});

test('reads a numeric user_id from a JSON POST body on /data', () => {
  const r = req(`${HOST}/data`, {
    method: 'POST',
    postData: JSON.stringify({ event_name: 'purchase', page_location: PAGE, user_id: 12345 }),
  });
  const [hit] = decodeRequest(r);
  expect(hit!.ids).toEqual({ user_id: true });
  expect(JSON.stringify(hit)).not.toContain('12345');
});

test('a JSON POST body without ids sets none', () => {
  const r = req(`${HOST}/data`, {
    method: 'POST',
    postData: JSON.stringify({ event_name: 'purchase', page_location: PAGE }),
  });
  expect(decodeRequest(r)[0]!.ids).toEqual({});
});
