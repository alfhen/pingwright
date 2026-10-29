import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, decoders, isCollectionEndpoint, isSandboxPageUrl } from './index.ts';

const PAGE = 'http://localhost:3000/products/fake-tee';
const SANDBOX = 'http://localhost:3000/web-pixels@0.0.0-fixture/sandbox/modern/';
const BASE = 'v=2&tid=G-PWTEST0001&cid=1111111111.2222222222';

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

const collect = (query: string, over: Partial<Request> = {}) =>
  req(`https://region1.google-analytics.com/g/collect?${query}`, over);

test('decodes a GET page_view', () => {
  const r = collect(`${BASE}&en=page_view&dl=${encodeURIComponent(PAGE)}`);
  const [hit, ...rest] = decodeRequest(r);
  expect(rest).toEqual([]);
  expect(hit).toMatchObject({
    type: 'hit',
    vendor: 'ga4',
    event: 'page_view',
    page: PAGE,
    transport: 'image',
    requestId: r.id,
    runId: r.runId,
    t: r.t,
    ids: { client_id: true },
    params: { tid: 'G-PWTEST0001' },
  });
  expect(hit?.ids).not.toHaveProperty('user_id');
});

test('decodes a three-event batch with shared URL params and per-line overrides', () => {
  const r = collect(`${BASE}&dl=${encodeURIComponent(PAGE)}&gcs=G111`, {
    method: 'POST',
    resourceType: 'fetch',
    postData: ['en=page_view', 'en=add_to_cart&ep.item=tee&epn.value=19.5', 'en=scroll&dl=https%3A%2F%2Fexample.com%2Fx&gcs=G100', ''].join('\n'),
  });
  const hits = decodeRequest(r);
  expect(hits.map((h) => h.event)).toEqual(['page_view', 'add_to_cart', 'scroll']);
  expect(new Set(hits.map((h) => h.id)).size).toBe(3);
  expect(hits.map((h) => h.page)).toEqual([PAGE, PAGE, 'https://example.com/x']);
  expect(hits[1]?.params).toEqual({ tid: 'G-PWTEST0001', item: 'tee', value: '19.5' });
  expect(hits.map((h) => h.consent.analytics)).toEqual(['granted', 'granted', 'denied']);
  expect(hits.every((h) => h.transport === 'fetch' && h.ids.client_id)).toBe(true);
});

test('uses the passed id factory', () => {
  const ids = ['hit_A', 'hit_B'] as const;
  let i = 0;
  const hits = decodeRequest(collect(`${BASE}`, { postData: 'en=a\nen=b' }), () => ids[i++] as `hit_${string}`);
  expect(hits.map((h) => h.id)).toEqual(['hit_A', 'hit_B']);
});

test('G100 is denied for ads and analytics', () => {
  const [hit] = decodeRequest(collect(`${BASE}&en=page_view&gcs=G100`));
  expect(hit?.consent).toMatchObject({
    ads: 'denied',
    analytics: 'denied',
    adUserData: 'unknown',
    adPersonalization: 'unknown',
    raw: { gcs: 'G100' },
  });
});

test('G111 is granted for ads and analytics', () => {
  const [hit] = decodeRequest(collect(`${BASE}&en=page_view&gcs=G111`));
  expect(hit?.consent).toMatchObject({ ads: 'granted', analytics: 'granted', raw: { gcs: 'G111' } });
});

test('G110 splits ads and analytics', () => {
  const [hit] = decodeRequest(collect(`${BASE}&en=page_view&gcs=G110`));
  expect(hit?.consent).toMatchObject({ ads: 'granted', analytics: 'denied' });
});

test('gcd with defaults and updates', () => {
  const [accepted] = decodeRequest(collect(`${BASE}&en=purchase&gcd=13r3r3r3r5`));
  expect(accepted?.consent).toEqual({
    ads: 'granted',
    analytics: 'granted',
    adUserData: 'granted',
    adPersonalization: 'granted',
    raw: { gcd: '13r3r3r3r5' },
  });
  const [mixed] = decodeRequest(collect(`${BASE}&en=purchase&gcd=11r1q1t1p5`));
  expect(mixed?.consent).toMatchObject({
    ads: 'granted',
    analytics: 'denied',
    adUserData: 'granted',
    adPersonalization: 'denied',
  });
  const [unset] = decodeRequest(collect(`${BASE}&en=purchase&gcd=13l3l3l2l2`));
  expect(unset?.consent).toMatchObject({
    ads: 'unknown',
    analytics: 'unknown',
    adUserData: 'unknown',
    adPersonalization: 'unknown',
  });
});

test('gcd with five letters, as gtag sends it', () => {
  const [granted] = decodeRequest(collect(`${BASE}&en=purchase&gcd=13r3r3r2r5l1`));
  expect(granted?.consent).toMatchObject({
    ads: 'granted',
    analytics: 'granted',
    adUserData: 'granted',
    adPersonalization: 'granted',
  });
  const [denied] = decodeRequest(collect(`${BASE}&en=purchase&gcd=13p3p3p2p5l1`));
  expect(denied?.consent).toMatchObject({
    ads: 'denied',
    analytics: 'denied',
    adUserData: 'denied',
    adPersonalization: 'denied',
  });
});

test('gcs wins over gcd for ads and analytics', () => {
  const [hit] = decodeRequest(collect(`${BASE}&en=x&gcs=G100&gcd=13r3r3r3r5`));
  expect(hit?.consent).toMatchObject({ ads: 'denied', analytics: 'denied', adUserData: 'granted' });
});

test('missing or malformed consent is unknown', () => {
  const [none] = decodeRequest(collect(`${BASE}&en=x`));
  const [bad] = decodeRequest(collect(`${BASE}&en=x&gcs=nope&gcd=zz`));
  for (const hit of [none, bad]) {
    expect(hit?.consent).toMatchObject({
      ads: 'unknown',
      analytics: 'unknown',
      adUserData: 'unknown',
      adPersonalization: 'unknown',
    });
  }
  expect(none?.consent.raw).toEqual({});
});

test('user_id is present only when uid is set', () => {
  const [withUid] = decodeRequest(collect(`${BASE}&en=purchase&uid=fixture-user-0001&gcs=G100`));
  const [without] = decodeRequest(collect(`${BASE}&en=purchase&uid=`));
  expect(withUid?.ids.user_id).toBe(true);
  expect(without?.ids).not.toHaveProperty('user_id');
});

test('ping maps to beacon and xhr stays', () => {
  const [beacon] = decodeRequest(collect(`${BASE}&en=x`, { resourceType: 'ping', method: 'POST' }));
  const [xhr] = decodeRequest(collect(`${BASE}&en=x`, { resourceType: 'xhr' }));
  expect(beacon?.transport).toBe('beacon');
  expect(xhr?.transport).toBe('xhr');
});

test('matches any host, including first-party server containers', () => {
  for (const host of [
    'www.google-analytics.com',
    'region1.google-analytics.com',
    'analytics.google.com',
    'sgtm.example.com',
  ]) {
    const r = req(`https://${host}/g/collect?${BASE}&en=page_view`);
    expect(decodeRequest(r)).toHaveLength(1);
    expect(isCollectionEndpoint(r)).toBe(true);
  }
});

test('does not match other paths or v=1', () => {
  for (const url of [
    `https://www.googletagmanager.com/gtag/js?id=G-PWTEST0001`,
    `https://www.google-analytics.com/j/collect?v=1&tid=UA-1`,
    `https://www.google-analytics.com/g/collect?tid=G-PWTEST0001&en=x`,
    `https://example.com/other?v=2`,
    'not a url',
  ]) {
    const r = req(url);
    expect(decodeRequest(r)).toEqual([]);
    expect(isCollectionEndpoint(r)).toBe(false);
  }
});

test('page from a sandbox frame is detectable', () => {
  const [hit] = decodeRequest(collect(`${BASE}&en=page_view&dl=${encodeURIComponent(SANDBOX)}`));
  expect(isSandboxPageUrl(hit?.page)).toBe(true);
  expect(isSandboxPageUrl(PAGE)).toBe(false);
  expect(isSandboxPageUrl(null)).toBe(false);
  expect(isSandboxPageUrl('/web-pixels@abc/sandbox/x')).toBe(true);
  expect(isSandboxPageUrl('http://localhost/?next=/web-pixels@1/sandbox/')).toBe(false);
  const custom = '/custom/web-pixel-000000001@1/sandbox/modern/page-name';
  expect(isSandboxPageUrl(`https://shop.example.com/web-pixels@abc123${custom}`)).toBe(true);
  expect(isSandboxPageUrl(`https://shop.example.com/wpm@0000000000000000${custom}`)).toBe(true);
  expect(isSandboxPageUrl('https://shop.example.com/products/sandbox/x')).toBe(false);
});

test('the registry lists ga4', () => {
  expect(decoders.map((d) => d.name)).toContain('ga4');
});

test('decodes /g/collect under a site path prefix', () => {
  const r = req(`https://shop.example.com/metrics/g/collect?${BASE}&en=page_view`);
  expect(isCollectionEndpoint(r)).toBe(true);
  expect(decodeRequest(r)[0]).toMatchObject({ vendor: 'ga4', event: 'page_view' });
  expect(isCollectionEndpoint(req('https://shop.example.com/metrics/g/collect?en=page_view'))).toBe(false);
  expect(isCollectionEndpoint(req(`https://shop.example.com/g/collector?${BASE}`))).toBe(false);
});
