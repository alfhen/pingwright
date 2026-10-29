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
