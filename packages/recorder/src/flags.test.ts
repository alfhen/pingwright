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
