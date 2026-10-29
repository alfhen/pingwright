import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, isCollectionEndpoint, meta } from './index.ts';

const PAGE = 'http://localhost:3000/thank-you';
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
    resourceType: 'image',
    frameUrl: PAGE,
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
    ...over,
  };
}

const q = (s: Record<string, string>) => new URLSearchParams(s).toString();

test('decodes a GET PageView', () => {
  const r = req(
    `https://www.facebook.com/tr/?${q({ id: '100000000000001', ev: 'PageView', dl: PAGE, eid: 'e-1' })}`,
  );
  const hits = decodeRequest(r);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    vendor: 'meta',
    event: 'PageView',
    page: PAGE,
    transport: 'image',
    requestId: r.id,
    params: { pixelId: '100000000000001', eid: 'e-1' },
    consent: { ads: 'unknown', analytics: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown' },
  });
});

test('decodes a POST Purchase with cd[*] and hashed ud[*]', () => {
  const r = req('https://www.facebook.com/tr', {
    method: 'POST',
    resourceType: 'fetch',
    postData: q({
      id: '100000000000001',
      ev: 'Purchase',
      dl: PAGE,
      'cd[value]': '19.5',
      'cd[currency]': 'USD',
      'ud[em]': HASH,
      'ud[ph]': 'b'.repeat(64),
    }),
  });
  const [hit] = decodeRequest(r);
  expect(hit?.event).toBe('Purchase');
  expect(hit?.params).toMatchObject({ value: '19.5', currency: 'USD', hashedEmail: HASH, hashedPhone: 'b'.repeat(64) });
  expect(hit?.ids).toEqual({ hashedEmail: true, hashedPhone: true });
});

test('no ud means no hashed ids', () => {
  const [hit] = decodeRequest(req(`https://facebook.com/tr?${q({ id: '100000000000001', ev: 'AddToCart' })}`));
  expect(hit?.ids).toEqual({});
  expect(hit?.page).toBeNull();
});

test('matches facebook.com/tr only; scripts are not collection endpoints', () => {
  expect(isCollectionEndpoint(req('https://www.facebook.com/tr?ev=PageView&id=1'))).toBe(true);
  for (const u of [
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://www.facebook.com/signals/config/100000000000001',
    'https://www.facebook.com/trx',
    'https://example.com/tr?ev=PageView',
  ]) {
    expect(meta.match(req(u))).toBe(false);
    expect(isCollectionEndpoint(req(u))).toBe(false);
  }
});
