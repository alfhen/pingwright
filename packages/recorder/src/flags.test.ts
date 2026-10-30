import { newId, type DataLayerEvent, type Hit, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { buildFlags, buildUnloadGapFlags, isFirstPartySubdomain, isUnknownDestination } from './flags.ts';

function req(url: string, over: Partial<Request> = {}): Request {
  return {
    type: 'request',
    id: newId('request'),
    runId: newId('run'),
    stepId: null,
    t: 1,
    method: 'GET',
    url,
    resourceType: 'image',
    frameUrl: null,
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'passed',
    ...over,
  };
}

const HOST = 'shop.example.com';

test.each([
  ['image with a query string', req('https://tracker.example.net/p?x=1'), true],
  ['image without data', req('https://tracker.example.net/p.gif'), false],
  ['image with a body', req('https://tracker.example.net/p', { postData: 'a=1' }), true],
  ['fetch without a query', req('https://tracker.example.net/p', { resourceType: 'fetch', method: 'POST' }), true],
  ['xhr', req('https://tracker.example.net/p', { resourceType: 'xhr' }), true],
  ['beacon', req('https://tracker.example.net/p', { resourceType: 'ping' }), true],
  ['script', req('https://cdn.example.net/a.js?v=1', { resourceType: 'script' }), false],
  ['stylesheet', req('https://cdn.example.net/a.css?v=1', { resourceType: 'stylesheet' }), false],
  ['font', req('https://cdn.example.net/a.woff?v=1', { resourceType: 'font' }), false],
  ['document', req('https://other.example.net/?q=1', { resourceType: 'document' }), false],
  ['the site host', req(`https://${HOST}/p?x=1`), false],
  ['a stubbed Meta pixel hit', req('https://www.facebook.com/tr/?id=100000000000001&ev=PageView'), false],
  ['a stubbed Ads remarketing hit', req('https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1/?x=1'), false],
  ['a decoder match', req('https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001', { resourceType: 'fetch' }), false],
])('unknown destination: %s', (_name, request, expected) => {
  expect(isUnknownDestination(request, HOST)).toBe(expected);
});

test('a listed tracker request is not an unknown destination', () => {
  const trackers = [{ vendor: 'tiktok', host: 'px.tiktok-test.example.net', source: 'https://example.com/docs' }];
  const listed = req('https://px.tiktok-test.example.net/e?x=1', { resourceType: 'fetch' });
  expect(isUnknownDestination(listed, HOST)).toBe(true);
  expect(isUnknownDestination(listed, HOST, trackers)).toBe(false);
});

test('flags unknown destinations, sandbox page URLs and unrouted collection requests', () => {
  const unknown = req('https://tracker.example.net/p?x=1');
  const unrouted = req('https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001', { resourceType: 'fetch' });
  const routed = req('https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&en=b', { resourceType: 'fetch' });
  const hit = {
    type: 'hit',
    id: newId('hit'),
    requestId: routed.id,
    vendor: 'ga4',
    page: 'https://shop.example.com/web-pixels@1/sandbox/modern/',
  } as Hit;
  const flags = buildFlags({
    networkMode: 'stub',
    runId: unknown.runId,
    siteUrl: `https://${HOST}/`,
    requests: [unknown, unrouted, routed],
    hits: [hit],
    routedRequestIds: new Set([unknown.id, routed.id]),
  });
  expect(flags.map((f) => [f.kind, f.recordIds[0]])).toEqual([
    ['unknownDestination', unknown.id],
    ['stubBypass', unrouted.id],
    ['sandboxPageUrl', hit.id],
  ]);
  expect(flags[2]?.recordIds).toEqual([hit.id, routed.id]);
});

const meta = 'https://www.facebook.com/tr/?id=100000000000001&ev=PageView';

function bypassFlags(request: Request, networkMode: 'stub' | 'server' | 'live') {
  return buildFlags({
    runId: request.runId,
    networkMode,
    siteUrl: `https://${HOST}/`,
    requests: [request],
    hits: [],
    routedRequestIds: new Set(),
  }).filter((f) => f.kind === 'stubBypass');
}

test('an unrouted known vendor collection request is a stubBypass, and a redirect hop says so', () => {
  const flags = bypassFlags(req(meta, { initiator: 'redirect' }), 'stub');
  expect(flags).toHaveLength(1);
  expect(flags[0]?.detail).toContain('redirect');
  expect(bypassFlags(req(meta), 'stub')).toHaveLength(1);
});

test('server mode flags stubBypass like stub mode', () => {
  expect(bypassFlags(req(meta, { initiator: 'redirect' }), 'server')).toHaveLength(1);
});

test('live mode never flags stubBypass', () => {
  expect(bypassFlags(req(meta, { initiator: 'redirect' }), 'live')).toEqual([]);
  expect(
    bypassFlags(req('https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001', { resourceType: 'fetch' }), 'live'),
  ).toEqual([]);
});

test('an unrouted library load is not a stubBypass', () => {
  expect(bypassFlags(req('https://connect.facebook.net/en_US/fbevents.js', { resourceType: 'script' }), 'stub')).toEqual([]);
});

const data = (host: string) => req(`https://${host}/p?x=1`);
const classify = (host: string, site: string, firstPartyHosts: string[] = []) => {
  const scope = { siteHost: site, firstPartyHosts };
  return isUnknownDestination(data(host), scope) ? 'unknown' : isFirstPartySubdomain(data(host), scope) ? 'subdomain' : 'none';
};

test.each([
  ['the exact site host', 'www.shop.example.com', 'www.shop.example.com', 'none'],
  ['a sibling subdomain', 'sgtm.shop.example.com', 'www.shop.example.com', 'subdomain'],
  ['the apex of the site', 'shop.example.com', 'www.shop.example.com', 'subdomain'],
  ['another registrable domain', 'tracker.example.net', 'www.shop.example.com', 'unknown'],
  ['a lookalike suffix', 'shop.example.com.evil.net', 'www.shop.example.com', 'unknown'],
  ['a co.uk subdomain', 'cdn.shop.co.uk', 'www.shop.co.uk', 'subdomain'],
  ['another site under co.uk', 'other.co.uk', 'www.shop.co.uk', 'unknown'],
  ['a private-suffix neighbour', 'other.github.io', 'me.github.io', 'unknown'],
  ['an IP host other than the site', '127.0.0.1', 'localhost', 'unknown'],
  ['another IP', '10.0.0.2', '10.0.0.1', 'unknown'],
  ['a localhost subdomain', 'a.localhost', 'localhost', 'unknown'],
])('first party: %s', (_name, host, site, expected) => {
  expect(classify(host, site)).toBe(expected);
});

test('firstPartyHosts: exact hosts and wildcards are first party and still visible', () => {
  const hosts = ['i.guim.co.uk', '*.shopifycdn.com'];
  expect(classify('i.guim.co.uk', 'www.shop.example.com', hosts)).toBe('subdomain');
  expect(classify('img.shopifycdn.com', 'www.shop.example.com', hosts)).toBe('subdomain');
  expect(classify('a.b.shopifycdn.com', 'www.shop.example.com', hosts)).toBe('subdomain');
  expect(classify('shopifycdn.com', 'www.shop.example.com', hosts)).toBe('unknown');
  expect(classify('x.guim.co.uk', 'www.shop.example.com', hosts)).toBe('unknown');
});

test('a first-party subdomain request becomes firstPartySubdomain, not unknownDestination', () => {
  const request = req('https://sgtm.shop.example.com/collect', { resourceType: 'fetch', method: 'POST' });
  const flags = buildFlags({
    runId: request.runId,
    networkMode: 'stub',
    siteUrl: 'https://www.shop.example.com/',
    requests: [request],
    hits: [],
    routedRequestIds: new Set([request.id]),
  });
  expect(flags.map((f) => [f.kind, f.recordIds[0]])).toEqual([['firstPartySubdomain', request.id]]);
});

test('first-party subdomain requests that cannot carry data are not flagged', () => {
  const script = req('https://cdn.shop.example.com/a.js?v=1', { resourceType: 'script' });
  expect(isFirstPartySubdomain(script, { siteHost: 'www.shop.example.com' })).toBe(false);
});

function pushed(event: string | null, t: number, over: Partial<DataLayerEvent> = {}): DataLayerEvent {
  return {
    type: 'dataLayerEvent',
    id: newId('dataLayerEvent'),
    runId: newId('run'),
    stepId: null,
    t,
    event,
    gtmUniqueEventId: null,
    args: [{ event }],
    isConsentCommand: false,
    ...over,
  };
}

function ga4Hit(event: string, t: number): Hit {
  return { type: 'hit', id: newId('hit'), runId: newId('run'), stepId: null, requestId: newId('request'), t, vendor: 'ga4', event } as Hit;
}

const gap = (over: Partial<Parameters<typeof buildUnloadGapFlags>[0]>) =>
  buildUnloadGapFlags({ runId: newId('run'), events: [], hits: [], navigations: [], ...over });

test('unload gap: an event from a frame shortly before a navigation, with no hit after it, is flagged', () => {
  const event = pushed('add_to_cart', 1000);
  const flags = gap({ events: [event], navigations: [4000] });
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({ kind: 'unloadGap', recordIds: [event.id] });
  expect(flags[0]!.detail).toContain('3.0 s');
});

test.each([
  ['a hit of that name was recorded after the event', { events: [pushed('add_to_cart', 1000)], hits: [ga4Hit('add_to_cart', 2000)], navigations: [4000] }],
  ['the navigation came more than 10 s later', { events: [pushed('add_to_cart', 1000)], navigations: [12000] }],
  ['no navigation followed', { events: [pushed('add_to_cart', 1000)], navigations: [500] }],
  ['a gtm.* event', { events: [pushed('gtm.js', 1000)], navigations: [2000] }],
  ['a consent command', { events: [pushed(null, 1000, { isConsentCommand: true })], navigations: [2000] }],
  ['an event without a name', { events: [pushed(null, 1000)], navigations: [2000] }],
])('unload gap: not flagged when %s', (_name, input) => {
  expect(gap(input)).toEqual([]);
});

test('unload gap: a hit of another name does not clear the event', () => {
  expect(gap({ events: [pushed('add_to_cart', 1000)], hits: [ga4Hit('page_view', 2000)], navigations: [3000] })).toHaveLength(1);
});
