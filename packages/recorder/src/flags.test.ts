import { newId, type DataLayerEvent, type Hit, type Request, type Response } from '@tagreeve/core';
import { describe, expect, test } from 'vitest';
import { buildFlags, buildUnloadGapFlags, isFirstPartySubdomain, isUnknownDestination, type FrameRef } from './flags.ts';

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

const sgtmHit = (event: string, t: number): Hit => ({ ...ga4Hit(event, t), vendor: 'sgtm' }) as Hit;

test('unload gap: an sgtm hit with the event name does not cover the missing GA4 hit', () => {
  const event = pushed('product_added_to_cart', 1000);
  const flags = gap({ events: [event], hits: [sgtmHit('product_added_to_cart', 1100), ga4Hit('page_view', 500)], navigations: [4000] });
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({ kind: 'unloadGap', recordIds: [event.id] });
  expect(flags[0]!.detail).toContain('no ga4 hit');
});

test('unload gap: a later GA4 hit with a GA4 event name covers an event with another name', () => {
  const hits = [sgtmHit('item_added', 1100), ga4Hit('add_to_cart', 1200)];
  expect(gap({ events: [pushed('item_added', 1000)], hits, navigations: [4000] })).toEqual([]);
});

test('unload gap: an sgtm hit alone does not flag when the run has no GA4', () => {
  expect(gap({ events: [pushed('item_added', 1000)], hits: [sgtmHit('item_added', 1100)], navigations: [4000] })).toEqual([]);
});

test('unload gap: an event that never produced a hit is skipped', () => {
  expect(gap({ events: [pushed('consent_update', 1000)], hits: [ga4Hit('page_view', 500)], navigations: [4000] })).toEqual([]);
});

test('unload gap: ignore takes names and globs', () => {
  const input = { events: [pushed('add_to_cart', 1000)], navigations: [4000] };
  expect(gap({ ...input, ignore: ['add_*'] })).toEqual([]);
  expect(gap({ ...input, ignore: ['add_to_cart'] })).toEqual([]);
  expect(gap({ ...input, ignore: ['add_to_car'] })).toHaveLength(1);
  expect(gap({ ...input, ignore: ['x.*'] })).toHaveLength(1);
});

test('unload gap: a GA4 hit after the next navigation does not cover the event', () => {
  const hits = [sgtmHit('product_added_to_cart', 1100), ga4Hit('begin_checkout', 9000)];
  expect(gap({ events: [pushed('product_added_to_cart', 1000)], hits, navigations: [4000, 8000] })).toHaveLength(1);
});

test('unload gap: a same-name GA4 hit on a later page does not cover a lost one', () => {
  const hits = [ga4Hit('add_to_cart', 21000)];
  expect(gap({ events: [pushed('add_to_cart', 1000)], hits, navigations: [4000, 30000] })).toHaveLength(1);
});

test('unload gap: a GA4 hit just after the navigation starts still covers the event', () => {
  expect(gap({ events: [pushed('add_to_cart', 1000)], hits: [ga4Hit('add_to_cart', 4500)], navigations: [4000] })).toEqual([]);
});

test('unload gap: with no GA4 hit in the run, an sgtm hit of the same name covers the event', () => {
  expect(gap({ events: [pushed('add_to_cart', 1000)], hits: [sgtmHit('add_to_cart', 1100)], navigations: [4000] })).toEqual([]);
});

test('unload gap: an sgtm hit before the push does not cover it', () => {
  expect(gap({ events: [pushed('add_to_cart', 1000)], hits: [sgtmHit('add_to_cart', 500)], navigations: [4000] })).toHaveLength(1);
});

test('unload gap: with no ga4 hit, a Shopify name is skipped because no vendor sent that literal name', () => {
  expect(gap({ events: [pushed('product_added_to_cart', 1000)], hits: [sgtmHit('add_to_cart', 1100)], navigations: [4000] })).toEqual([]);
});

test('unload gap: a Shopify event name is matched to its GA4 name', () => {
  const hits = [ga4Hit('add_to_cart', 1200)];
  expect(gap({ events: [pushed('product_added_to_cart', 1000)], hits, navigations: [4000] })).toEqual([]);
  expect(gap({ events: [pushed('product_added_to_cart', 1000)], hits: [ga4Hit('begin_checkout', 1200), sgtmHit('product_added_to_cart', 1100)], navigations: [4000] })).toHaveLength(1);
});

test('unload gap: a Shopify alias name that no vendor answered is skipped, with GA4 hits in the run', () => {
  expect(gap({ events: [pushed('product_viewed', 1000)], hits: [ga4Hit('page_view', 500)], navigations: [4000] })).toEqual([]);
  expect(gap({ events: [pushed('product_added_to_cart', 1000)], hits: [ga4Hit('page_view', 500)], navigations: [4000] })).toEqual([]);
});

test('unload gap: a Shopify alias name that a non-GA4 vendor answered is skipped when the run has no GA4 hit', () => {
  expect(gap({ events: [pushed('product_added_to_cart', 1000)], hits: [sgtmHit('product_added_to_cart', 500)], navigations: [4000] })).toEqual([]);
});

test('unload gap: the advice depends on the network mode', () => {
  const input = { events: [pushed('add_to_cart', 1000)], navigations: [4000] };
  const stub = gap({ ...input, networkMode: 'stub' })[0]!.detail;
  expect(stub).toContain('unloadGapIgnore');
  expect(stub).toContain('--network live --net-log');
  expect(gap({ ...input, networkMode: 'live' })[0]!.detail).toContain('not captured without --net-log');
});

describe('unload gap at run end and in the same frame', () => {
  test('a push 3 s before the run ended is flagged with the run-end text', () => {
    const flags = gap({ events: [pushed('add_to_cart', 1000)], runEnd: 4000 });
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toContain('3.0 s before the run ended');
  });

  test('a navigation keeps the navigation text', () => {
    expect(gap({ events: [pushed('add_to_cart', 1000)], navigations: [4000], runEnd: 9000 })[0]!.detail).toContain('before the page navigated');
  });

  test('a covering GA4 hit before the run ended clears it', () => {
    const events = [pushed('add_to_cart', 1000)];
    expect(gap({ events, runEnd: 4000 })).toHaveLength(1);
    expect(gap({ events, hits: [ga4Hit('add_to_cart', 2000)], runEnd: 4000 })).toEqual([]);
    expect(gap({ events, hits: [ga4Hit('add_to_cart', 5500)], runEnd: 4000 })).toHaveLength(1);
  });

  test('a push 12 s before the run ended is not flagged', () => {
    expect(gap({ events: [pushed('add_to_cart', 1000)], runEnd: 13000 })).toEqual([]);
  });

  describe('same frame', () => {
    const frameA = { id: '1.0', url: 'https://shop.example.com/sandbox/a/' };
    const sameUrlOtherFrame = { id: '2.0', url: frameA.url };
    const nextDocument = { id: '1.1', url: frameA.url };
    const srcdocA = { id: '3.0', url: 'about:srcdoc' };
    const srcdocB = { id: '4.0', url: 'about:srcdoc' };
    const netLog = { id: null, url: frameA.url };

    const run = (pushFrame: FrameRef, hitFrame: FrameRef | null, hitName = 'custom_ga') => {
      const event = pushed('my_add', 1000);
      const hits = [sgtmHit('my_add', 1100), ga4Hit(hitName, 1200)];
      return gap({ events: [event], hits, runEnd: 4000, eventFrames: new Map([[event.id, pushFrame]]), requestFrames: new Map([[hits[1]!.requestId as string, hitFrame]]) });
    };

    test('a GA4 hit with a non-GA4 name from the same frame document covers a custom name', () => {
      expect(run(frameA, frameA)).toEqual([]);
    });

    test('a GA4 hit with a non-GA4 name from another frame does not cover it', () => {
      expect(run(frameA, { id: '5.0', url: 'https://shop.example.com/sandbox/b/' })).toHaveLength(1);
    });

    test('two frames with the same URL do not cover each other', () => {
      expect(run(frameA, sameUrlOtherFrame)).toHaveLength(1);
      expect(run(srcdocA, srcdocB)).toHaveLength(1);
    });

    test('the same frame after a navigation is another document', () => {
      expect(run(frameA, nextDocument)).toHaveLength(1);
    });

    test('a request without a Frame object falls back to the frame URL', () => {
      expect(run(frameA, netLog)).toEqual([]);
      expect(run(frameA, { id: null, url: 'https://shop.example.com/sandbox/b/' })).toHaveLength(1);
      expect(run(frameA, null)).toHaveLength(1);
    });

    test('a same-frame hit sent before the push does not cover it', () => {
      const event = pushed('add_to_cart', 1000);
      const hit = ga4Hit('page_view', 500);
      const flags = gap({ events: [event], hits: [hit], runEnd: 4000, eventFrames: new Map([[event.id, frameA]]), requestFrames: new Map([[hit.requestId as string, frameA]]) });
      expect(flags).toHaveLength(1);
    });
  });
});

describe('possibleRedirectHop', () => {
  const failed = () => req('http://localhost:3000/r', { resourceType: 'fetch', outcome: 'failed', failure: 'net::ERR_FAILED' });
  const redirectFlags = (request: Request, over: Partial<Parameters<typeof buildFlags>[0]> = {}) =>
    buildFlags({
      runId: request.runId,
      networkMode: 'stub',
      siteUrl: 'http://localhost:3000/',
      requests: [request],
      hits: [],
      routedRequestIds: new Set([request.id]),
      handedToChromium: new Set([request.id]),
      ...over,
    }).filter((f) => f.kind === 'possibleRedirectHop');

  test('a request handed to Chromium that fails with no response is flagged', () => {
    const request = failed();
    const flags = redirectFlags(request);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.recordIds).toEqual([request.id]);
    expect(flags[0]?.detail).toContain('may have');
  });

  test('a request answered with a Location header but no redirect status is flagged', () => {
    const request = req('http://localhost:3000/r', { resourceType: 'fetch', outcome: 'passed' });
    const flags = redirectFlags(request, { redirectHeaderWithoutRedirect: new Set([request.id]) });
    expect(flags).toHaveLength(1);
    expect(flags[0]?.detail).toContain('Location header');
    expect(redirectFlags(request, { redirectHeaderWithoutRedirect: new Set([request.id]), networkMode: 'live' })).toEqual([]);
    expect(redirectFlags(request, { redirectHeaderWithoutRedirect: new Set([request.id]), handedToChromium: new Set() })).toEqual([]);
  });

  test('a response, another failure, a recorder-made failure or live mode is not flagged', () => {
    const request = failed();
    const response = { type: 'response', id: newId('response'), requestId: request.id, status: 302, setCookieNames: [] } as Response;
    expect(redirectFlags(request, { responses: [response] })).toEqual([]);
    expect(redirectFlags({ ...request, failure: 'net::ERR_ABORTED' })).toEqual([]);
    expect(redirectFlags(request, { handedToChromium: new Set() })).toEqual([]);
    expect(redirectFlags(request, { networkMode: 'live' })).toEqual([]);
  });
});

describe('platform hosts', () => {
  const build = (requests: Request[], platformHosts?: boolean) =>
    buildFlags({
      runId: requests[0]!.runId,
      networkMode: 'stub',
      siteUrl: 'https://www.shop.example.com/',
      requests,
      hits: [],
      routedRequestIds: new Set(requests.map((r) => r.id)),
      ...(platformHosts !== undefined && { platformHosts }),
    });
  const kinds = (requests: Request[], platformHosts?: boolean) => build(requests, platformHosts).map((f) => f.kind);

  test('a request to a listed Shopify host is a platformHost flag with the same detail', () => {
    const r = req('https://cdn.shopify.com/s/trekkie.js?v=1', { resourceType: 'fetch' });
    expect(isUnknownDestination(r, 'www.shop.example.com')).toBe(true);
    expect(build([r]).map((f) => [f.kind, f.detail])).toEqual([['platformHost', `GET ${r.url}`]]);
  });

  test('a request to the Shopify telemetry host is a platformHost flag', () => {
    const r = req('https://monorail-edge.shopifysvc.com/v1/produce?x=1', { resourceType: 'fetch', method: 'POST' });
    expect(kinds([r])).toEqual(['platformHost']);
    expect(kinds([r], false)).toEqual(['unknownDestination']);
  });

  test('an unlisted Shopify subdomain and a third-party payment host stay unknown destinations', () => {
    const unlisted = req('https://unlisted.shopify.com/x?y=1');
    const stripe = req('https://js.stripe.com/v3/m?x=1');
    expect(kinds([unlisted, stripe])).toEqual(['unknownDestination', 'unknownDestination']);
  });

  test('platformHosts false restores unknownDestination for a listed host', () => {
    const r = req('https://cdn.shopify.com/s/x?v=1');
    expect(kinds([r], false)).toEqual(['unknownDestination']);
    expect(kinds([r], true)).toEqual(['platformHost']);
  });
});

describe('requests from the server container', () => {
  const input = (requests: Request[]) => ({
    runId: newId('run'),
    networkMode: 'server' as const,
    siteUrl: `https://${HOST}/`,
    requests,
    hits: [],
    routedRequestIds: new Set<string>(),
  });
  const fromContainer = (url: string, over: Partial<Request> = {}) =>
    req(url, { resourceType: 'fetch', method: 'POST', initiator: 'serverContainer', outcome: 'stubbed', captured: 'serverContainer', ...over });

  test('a call to a collection endpoint that is not in routedRequestIds is no stubBypass', () => {
    const call = fromContainer('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001');
    expect(buildFlags(input([call])).map((f) => f.kind)).not.toContain('stubBypass');
  });

  test('the same request seen by the browser and not routed is a stubBypass', () => {
    const browser = req('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001', { resourceType: 'fetch', method: 'POST' });
    expect(buildFlags(input([browser])).map((f) => f.kind)).toContain('stubBypass');
  });

  test('a call to a host no decoder knows is an unknownDestination from the server container, even with no query', () => {
    const call = fromContainer('https://api.unknown-vendor.example/v1/events');
    const flags = buildFlags(input([call]));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ kind: 'unknownDestination', recordIds: [call.id] });
    expect(flags[0]!.detail).toBe(`from the server container: POST ${call.url}`);
  });

  test('a call to a platform host is still an unknownDestination', () => {
    const url = 'https://monorail-edge.shopifysvc.com/unstable/produce_batch';
    expect(buildFlags(input([req(url, { resourceType: 'fetch', method: 'POST' })])).map((f) => f.kind)).toEqual(['platformHost']);
    expect(buildFlags(input([fromContainer(url)])).map((f) => f.kind)).toEqual(['unknownDestination']);
  });

  test('a call to a first-party subdomain is an unknownDestination flag, not firstPartySubdomain', () => {
    const call = fromContainer(`https://sgtm.${HOST}/custom`);
    const flags = buildFlags(input([call]));
    expect(flags.map((f) => f.kind)).toEqual(['unknownDestination']);
    expect(flags[0]!.detail).toContain('from the server container:');
  });
});
