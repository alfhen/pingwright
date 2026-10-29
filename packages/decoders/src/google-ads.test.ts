import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, googleAds, isCollectionEndpoint } from './index.ts';

const PAGE = 'http://localhost:3000/thank-you';

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

const enc = encodeURIComponent;

test('googleadservices conversion with label, page and click id', () => {
  const [hit] = decodeRequest(
    req(
      `https://www.googleadservices.com/pagead/conversion/000000001/?label=fake-label&value=19.5&currency_code=USD&url=${enc(PAGE)}&gclid=fake-gclid&gcs=G100`,
    ),
  );
  expect(hit).toMatchObject({
    vendor: 'google-ads',
    event: 'conversion',
    page: PAGE,
    ids: { gclid: true },
    params: { conversionId: '000000001', label: 'fake-label', value: '19.5', currency: 'USD' },
    consent: { ads: 'denied', analytics: 'denied' },
  });
});

test('doubleclick view-through conversion is remarketing', () => {
  const [hit] = decodeRequest(
    req(`https://googleads.g.doubleclick.net/pagead/viewthroughconversion/000000001/?url=${enc(PAGE)}&gcd=13r3r3r3r5&gbraid=x&wbraid=y`),
  );
  expect(hit).toMatchObject({
    event: 'remarketing',
    page: PAGE,
    ids: { gbraid: true, wbraid: true },
    params: { conversionId: '000000001' },
  });
  expect(hit?.ids).not.toHaveProperty('gclid');
  expect(hit?.consent.ads).toBe('granted');
});

test('real gcd shape without gcs gives consent on viewthroughconversion and rmkt', () => {
  const urls = [
    `https://googleads.g.doubleclick.net/pagead/viewthroughconversion/000000001/?url=${enc(PAGE)}&gcd=`,
    `https://www.google.com/rmkt/collect/000000001/123?url=${enc(PAGE)}&gcd=`,
  ];
  for (const u of urls) {
    const [granted] = decodeRequest(req(`${u}13r3r3r2r5l1`));
    const [denied] = decodeRequest(req(`${u}13p3p3p2p5l1`));
    expect(granted?.consent).toMatchObject({ ads: 'granted', analytics: 'granted', adUserData: 'granted', adPersonalization: 'granted' });
    expect(denied?.consent).toMatchObject({ ads: 'denied', analytics: 'denied', adUserData: 'denied', adPersonalization: 'denied' });
  }
});

test('google.com 1p-conversion and 1p-user-list', () => {
  const [conv] = decodeRequest(req('https://www.google.com/pagead/1p-conversion/000000001/?label=fake-label'));
  const [list] = decodeRequest(req('https://www.google.com/pagead/1p-user-list/000000001/?dl=' + enc(PAGE)));
  expect(conv?.event).toBe('conversion');
  expect(list).toMatchObject({ event: 'remarketing', page: PAGE });
});

test('rmkt/collect and googlesyndication pings', () => {
  const [a] = decodeRequest(req('https://www.google.com/rmkt/collect/000000001/123?url=' + enc(PAGE)));
  const [b] = decodeRequest(req('https://pagead2.googlesyndication.com/pagead/conversion/000000001/?label=l'));
  expect(a).toMatchObject({ event: 'remarketing', params: { conversionId: '000000001' } });
  expect(b?.params.label).toBe('l');
});

test('ccm/collect on google.com and doubleclick uses en and tid', () => {
  for (const host of ['www.google.com', 'ad.doubleclick.net']) {
    const [hit] = decodeRequest(
      req(`https://${host}/ccm/collect?tid=AW-000000001&en=page_view&dl=${enc(PAGE)}&gcs=G111`, {
        method: 'POST',
        resourceType: 'fetch',
      }),
    );
    expect(hit).toMatchObject({
      event: 'page_view',
      page: PAGE,
      params: { conversionId: '000000001' },
      consent: { ads: 'granted', analytics: 'granted' },
    });
  }
});

test('ad.doubleclick.net ccm/s/collect is a collection endpoint', () => {
  const r = req(
    'https://ad.doubleclick.net/ccm/s/collect?auid=123.456&gtm=45je6a00v9100000000za200_AW-000000001&fmt=8&gcs=G111',
    { method: 'POST', resourceType: 'fetch' },
  );
  expect(isCollectionEndpoint(r)).toBe(true);
  const [hit] = decodeRequest(r);
  expect(hit).toMatchObject({
    vendor: 'google-ads',
    event: 'remarketing',
    params: { conversionId: '000000001' },
    consent: { ads: 'granted', analytics: 'granted' },
  });
});

test('each redirect hop is its own request and hit', () => {
  const first = req('https://www.googleadservices.com/pagead/conversion/000000001/?label=l');
  const second = req('https://www.google.com/pagead/1p-conversion/000000001/?label=l');
  const a = decodeRequest(first);
  const b = decodeRequest(second);
  expect(a).toHaveLength(1);
  expect(b).toHaveLength(1);
  expect(a[0]?.requestId).not.toBe(b[0]?.requestId);
});

test('script loads and other paths are not collection endpoints', () => {
  for (const u of [
    'https://www.googletagmanager.com/gtag/js?id=AW-000000001',
    'https://www.googleadservices.com/pagead/conversion_async.js',
    'https://www.google.com/search?q=x',
    'https://example.com/pagead/conversion/000000001/',
    'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
  ]) {
    expect(googleAds.match(req(u))).toBe(false);
    expect(isCollectionEndpoint(req(u))).toBe(false);
  }
});
