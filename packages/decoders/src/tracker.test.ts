import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, isCollectionEndpoint, trackerCollection, type TrackerEntry } from './index.ts';

const PAGE = 'http://localhost:3000/shop';

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

const user: TrackerEntry[] = [
  { vendor: 'tiktok', host: 'px.tiktok-test.example.com', source: 'https://example.com/docs' },
  { vendor: 'criteo', host: 'c.criteo-test.example.com', paths: ['/m/collect'], source: 'https://example.com/docs' },
];

test('a built-in tracker path gives a minimal hit', () => {
  const [hit, ...rest] = decodeRequest(req('https://px.ads.linkedin.com/wa/?pid=1&event=Lead&url=https%3A%2F%2Fshop.example.com%2Fa'));
  expect(rest).toEqual([]);
  expect(hit).toMatchObject({
    vendor: 'linkedin',
    event: 'Lead',
    page: 'https://shop.example.com/a',
    transport: 'tracker-list',
    params: {},
    ids: {},
    consent: { ads: 'unknown', analytics: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} },
  });
});

test('the event is null and the page is the frame URL when no common parameter is present', () => {
  const [hit] = decodeRequest(req('https://alb.reddit.com/rp.gif?id=x'));
  expect(hit).toMatchObject({ vendor: 'reddit', event: null, page: PAGE });
});

test('a user entry decodes when it is passed in', () => {
  const r = req('https://px.tiktok-test.example.com/api/pixel?ev=Purchase', { resourceType: 'fetch' });
  expect(decodeRequest(r)).toEqual([]);
  expect(decodeRequest(r, undefined, user).map((h) => [h.vendor, h.event])).toEqual([['tiktok', 'Purchase']]);
});

test('a listed path is a collection endpoint for every resource type', () => {
  for (const resourceType of ['image', 'fetch', 'ping', 'script', 'document', 'other']) {
    const r = req('https://c.criteo-test.example.com/m/collect?event=viewItem', { resourceType });
    expect(isCollectionEndpoint(r, user)).toBe(true);
    expect(decodeRequest(r, undefined, user)).toHaveLength(1);
  }
  expect(isCollectionEndpoint(req('https://c.criteo-test.example.com/m/other'), user)).toBe(false);
});

test('a whole-host entry skips script, stylesheet, font and document loads and library paths', () => {
  for (const resourceType of ['script', 'stylesheet', 'font', 'document']) {
    expect(trackerCollection(req('https://px.tiktok-test.example.com/events.js', { resourceType }), user)).toBeUndefined();
  }
  expect(trackerCollection(req('https://px.tiktok-test.example.com/fbevents.js', { resourceType: 'fetch' }), user)).toBeUndefined();
  for (const resourceType of ['image', 'fetch', 'xhr', 'ping', 'other']) {
    expect(trackerCollection(req('https://px.tiktok-test.example.com/e', { resourceType }), user)?.vendor).toBe('tiktok');
  }
});

test('a request that a real decoder matches gives only that decoder hit', () => {
  const overlapping: TrackerEntry[] = [{ vendor: 'mine', host: 'region1.google-analytics.com', source: 'https://example.com/docs' }];
  const r = req('https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=page_view', { resourceType: 'fetch' });
  expect(decodeRequest(r, undefined, overlapping).map((h) => h.vendor)).toEqual(['ga4']);
});

test('an unlisted host gives no hit', () => {
  expect(decodeRequest(req('https://unlisted.example.net/p?event=x'), undefined, user)).toEqual([]);
});

test('a sandbox frame URL is not reported as the page a tracker received', () => {
  const [hit] = decodeRequest(
    req('https://px.ads.linkedin.com/wa/?pid=1', { frameUrl: 'https://shop.example.com/web-pixels@x/sandbox/modern/' }),
  );
  expect(hit?.vendor).toBe('linkedin');
  expect(hit?.page).toBeNull();
});

test('a whole-host image with no query and no body is stubbed but gives no hit', () => {
  const r = req('https://alb.reddit.com/rp.gif');
  expect(isCollectionEndpoint(r)).toBe(true);
  expect(decodeRequest(r)).toEqual([]);
  expect(decodeRequest(req('https://alb.reddit.com/rp.gif', { method: 'POST', postData: 'a=1' }))).toHaveLength(1);
  expect(decodeRequest(req('https://alb.reddit.com/rp.gif?id=x'))).toHaveLength(1);
  expect(decodeRequest(req('https://alb.reddit.com/rp', { resourceType: 'fetch' }))).toHaveLength(1);
});
