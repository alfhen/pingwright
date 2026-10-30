import { readFileSync } from 'node:fs';
import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, isCollectionEndpoint } from './index.ts';

const PAGE = 'http://localhost:3000/pinterest';
const TID = '2612345678901';
const HASH = 'a'.repeat(64);

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

const json = (o: object) => JSON.stringify(o);
const v3 = (q: Record<string, string>) => `https://ct.pinterest.com/v3/?${new URLSearchParams(q)}`;

const capture = (
  JSON.parse(readFileSync(new URL('../fixtures/pinterest/capture.json', import.meta.url), 'utf8')) as {
    method: string;
    url: string;
    resourceType: Request['resourceType'];
  }[]
).map((c) => req(c.url, { method: c.method, resourceType: c.resourceType }));

const captured = (event: string) => {
  const r = capture.find((c) => new URL(c.url).searchParams.get('event') === event);
  if (!r) throw new Error(`no ${event} in capture`);
  return r;
};

test('capture: init carries the tag, hashed email and page', () => {
  const [hit] = decodeRequest(captured('init'));
  expect(hit).toMatchObject({
    vendor: 'pinterest',
    event: 'init',
    page: expect.stringMatching(/\/pinterest$/),
    transport: 'fetch',
    ids: { hashedEmail: true },
    params: { tagId: TID, hashedEmail: expect.stringMatching(/^[0-9a-f]{64}$/) },
  });
});

test('capture: pagevisit on /user/ has no page and no ids', () => {
  const [hit] = decodeRequest(captured('pagevisit'));
  expect(hit).toMatchObject({ event: 'pagevisit', page: null, ids: {}, params: { tagId: TID } });
});

test('capture: addtocart reads ed and the event id', () => {
  const [hit] = decodeRequest(captured('addtocart'));
  expect(hit?.params).toEqual({
    tagId: TID,
    value: '19.5',
    order_quantity: '1',
    currency: 'USD',
    eventId: 'fixture-event-0001',
  });
});

test('capture: checkout reads ed', () => {
  const [hit] = decodeRequest(captured('checkout'));
  expect(hit).toMatchObject({ event: 'checkout', params: { value: '19.5', order_id: 'fixture-order-0001' } });
});

test('core.js format: v3 pagevisit with JSON ad and pd', () => {
  const r = req(
    v3({
      tid: TID,
      event: 'pagevisit',
      ad: json({ loc: PAGE, ref: '', if: false, sh: 720, sw: 1280 }),
      pd: json({ em: HASH, tm: 'gtm' }),
      cb: '1',
    }),
    { resourceType: 'image' },
  );
  const [hit] = decodeRequest(r);
  expect(hit).toMatchObject({
    vendor: 'pinterest',
    event: 'pagevisit',
    page: PAGE,
    transport: 'image',
    requestId: r.id,
    ids: { hashedEmail: true },
    params: { tagId: TID, hashedEmail: HASH },
  });
});

test('docs img layout: bracketed ed[...] and pd[em]', () => {
  const url =
    `https://ct.pinterest.com/v3/?tid=${TID}&event=checkout&ed[value]=10.00&ed[order_quantity]=2` +
    `&ed[event_id]=eid-1&ed[line_items][0][product_id]=sku-1&pd[em]=${HASH}&noscript=1`;
  const [hit] = decodeRequest(req(url, { resourceType: 'image' }));
  expect(hit).toMatchObject({
    vendor: 'pinterest',
    event: 'checkout',
    ids: { hashedEmail: true },
    params: {
      tagId: TID,
      value: '10.00',
      order_quantity: '2',
      eventId: 'eid-1',
      'line_items.0.product_id': 'sku-1',
      hashedEmail: HASH,
    },
  });
});

test('JSON ed nested values flatten to the same dotted keys as the img layout', () => {
  const ed = { value: 10, event_id: 'eid-1', line_items: [{ product_id: 'sku-1' }] };
  const [hit] = decodeRequest(req(v3({ tid: TID, event: 'checkout', ed: json(ed) })));
  expect(hit?.params).toMatchObject({ value: '10', eventId: 'eid-1', 'line_items.0.product_id': 'sku-1' });
});

test('no pd.em means no id; empty or bad JSON is ignored', () => {
  const [a] = decodeRequest(req(v3({ tid: TID, event: 'init', pd: json({ em: '' }) })));
  expect(a?.ids).toEqual({});
  const [b] = decodeRequest(req(v3({ tid: TID, event: 'init', ed: '{nope', ad: '[1]' })));
  expect(b).toMatchObject({ page: null, params: { tagId: TID } });
});

test('/v3/ and /user/ decode, the whole ct.pinterest.com host is stubbed', () => {
  expect(isCollectionEndpoint(req(`https://ct.pinterest.com/user/?tid=${TID}`))).toBe(true);
  expect(isCollectionEndpoint(req(`https://ct.pinterest.com/v3?tid=${TID}`))).toBe(true);
  expect(isCollectionEndpoint(req('https://ct.pinterest.com/stats/', { resourceType: 'xhr' }))).toBe(true);
  expect(isCollectionEndpoint(req('https://s.pinimg.com/ct/core.js', { resourceType: 'script' }))).toBe(false);
  expect(decodeRequest(req('https://ct.pinterest.com/other'))).toEqual([]);
  expect(decodeRequest(req('https://ct.pinterest.com.example.com/v3/'))).toEqual([]);
});
