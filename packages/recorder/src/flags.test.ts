import { newId, type Hit, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { buildFlags, isUnknownDestination } from './flags.ts';

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

function bypassFlags(request: Request, networkMode: 'stub' | 'live') {
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

test('live mode never flags stubBypass', () => {
  expect(bypassFlags(req(meta, { initiator: 'redirect' }), 'live')).toEqual([]);
  expect(
    bypassFlags(req('https://region1.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001', { resourceType: 'fetch' }), 'live'),
  ).toEqual([]);
});

test('an unrouted library load is not a stubBypass', () => {
  expect(bypassFlags(req('https://connect.facebook.net/en_US/fbevents.js', { resourceType: 'script' }), 'stub')).toEqual([]);
});
