import { createIdentity, hashEmail, newId, type Hit, type Request } from '@tagreeve/core';
import { describe, expect, test } from 'vitest';
import { linkServerHits } from './link.ts';

const identity = createIdentity(1);
const hosts = ['sgtm.example.invalid'];

function request(url: string, over: Partial<Request> = {}): Request {
  return {
    type: 'request', id: newId('request'), runId: newId('run'), stepId: null, t: 1, method: 'POST', url, resourceType: 'fetch',
    frameUrl: null, initiator: null, headers: {}, postData: null, outcome: 'passed', ...over,
  };
}

const serverRequest = (url: string, over: Partial<Request> = {}) => request(url, { captured: 'serverContainer', initiator: 'serverContainer', outcome: 'stubbed', ...over });

function hit(req: Request, vendor: string, event: string | null, t: number, params: Record<string, string> = {}): Hit {
  return {
    type: 'hit', id: newId('hit'), runId: req.runId, stepId: null, requestId: req.id, t, vendor, event,
    consent: { ads: 'unknown', analytics: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} },
    ids: {}, page: null, transport: 'fetch', params,
  };
}

function link(pairs: Array<[Request, Hit]>, serverHosts = hosts) {
  const out = linkServerHits({ hits: pairs.map(([, h]) => h), requests: pairs.map(([r]) => r), serverHosts, identity });
  return out.map((h) => h.via);
}

const pixelReq = request('https://www.facebook.com/tr/?id=1&ev=Purchase&eid=evt-12345678', { t: 10 });
const pixel = hit(pixelReq, 'meta', 'Purchase', 10, { eid: 'evt-12345678' });

describe('rule 1: event ID and event name', () => {
  test('both match one browser hit: exact', () => {
    const capiReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 50 });
    const capi = hit(capiReq, 'meta-capi', 'Purchase', 50, { eventId: 'evt-12345678' });
    expect(link([[pixelReq, pixel], [capiReq, capi]])[1]).toEqual({ hitId: pixel.id, by: 'eventId', confidence: 'exact' });
  });

  test('the same ID with another name is probable', () => {
    const capiReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 50 });
    const capi = hit(capiReq, 'meta-capi', 'Lead', 50, { eventId: 'evt-12345678' });
    expect(link([[pixelReq, pixel], [capiReq, capi]])[1]).toEqual({ hitId: pixel.id, by: 'eventId', confidence: 'probable' });
  });

  test('two browser hits with the same ID and name are not exact', () => {
    const other = hit(request('https://www.facebook.com/tr/?ev=Purchase&eid=evt-12345678', { t: 20 }), 'meta', 'Purchase', 20, { eid: 'evt-12345678' });
    const capiReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 50 });
    const capi = hit(capiReq, 'meta-capi', 'Purchase', 50, { eventId: 'evt-12345678' });
    const via = link([[pixelReq, pixel], [{ ...pixelReq, id: other.requestId }, other], [capiReq, capi]])[2];
    expect(via?.confidence).toBe('probable');
    expect(via?.hitId).toBe(other.id);
  });

  test('a GA4 call with the same event ID and name is exact too', () => {
    const ga4Req = serverRequest('https://www.google-analytics.com/g/collect', { t: 50 });
    const ga4 = hit(ga4Req, 'ga4', 'Purchase', 50, { event_id: 'evt-12345678' });
    expect(link([[pixelReq, pixel], [ga4Req, ga4]])[1]?.confidence).toBe('exact');
  });

  test('a browser hit is never given a via, and a call is never exact to another call', () => {
    const a = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 40 });
    const b = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 50 });
    const hitA = hit(a, 'meta-capi', 'Purchase', 40, { eventId: 'evt-12345678' });
    const hitB = hit(b, 'meta-capi', 'Purchase', 50, { eventId: 'evt-12345678' });
    expect(link([[pixelReq, pixel], [a, hitA], [b, hitB]])).toEqual([
      undefined,
      { hitId: pixel.id, by: 'eventId', confidence: 'exact' },
      { hitId: pixel.id, by: 'eventId', confidence: 'exact' },
    ]);
  });
});

describe('rule 3: a shared value', () => {
  const serverHostReq = (path: string, t: number, over: Partial<Request> = {}) => request(`https://sgtm.example.invalid${path}`, { t, ...over });

  test('a client ID and event name on a request in flight link as probable, not exact', () => {
    const inFlight = serverHostReq('/g/collect?cid=pw-client-0001&en=Purchase', 100);
    const browser = hit(inFlight, 'ga4', 'Purchase', 100);
    const callReq = serverRequest('https://www.google-analytics.com/g/collect?cid=pw-client-0001&en=Purchase', { t: 110 });
    const call = hit(callReq, 'ga4', 'Purchase', 110);
    expect(link([[inFlight, browser], [callReq, call]])[1]).toEqual({ hitId: browser.id, by: 'clientId', confidence: 'probable' });
  });

  test('a client ID alone links, from the body too', () => {
    const browserReq = serverHostReq('/data', 100, { postData: JSON.stringify({ client_id: 'pw-client-0002' }) });
    const browser = hit(browserReq, 'sgtm', 'page_view', 100);
    const callReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 120, postData: JSON.stringify({ data: [{ user_data: { fbp: 'pw-client-0002' } }] }) });
    const call = hit(callReq, 'meta-capi', 'Lead', 120);
    expect(link([[browserReq, browser], [callReq, call]])[1]).toMatchObject({ by: 'clientId', confidence: 'probable' });
  });

  test('the latest hit to a serverHosts host wins over a later hit elsewhere', () => {
    const early = serverHostReq('/g/collect?cid=pw-client-0003', 100);
    const late = request('https://www.google-analytics.com/g/collect?cid=pw-client-0003', { t: 200 });
    const earlyHit = hit(early, 'ga4', 'a', 100);
    const lateHit = hit(late, 'ga4', 'b', 200);
    const callReq = serverRequest('https://www.google-analytics.com/g/collect?cid=pw-client-0003', { t: 300 });
    expect(link([[early, earlyHit], [late, lateHit], [callReq, hit(callReq, 'ga4', 'c', 300)]])[2]?.hitId).toBe(earlyHit.id);
  });

  test('without a serverHosts hit it takes the latest browser hit that holds the value', () => {
    const first = request('https://www.google-analytics.com/g/collect?cid=pw-client-0004', { t: 100 });
    const second = request('https://www.google-analytics.com/g/collect?cid=pw-client-0004', { t: 200 });
    const secondHit = hit(second, 'ga4', 'b', 200);
    const callReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 300, postData: JSON.stringify({ data: [{ user_data: { fbp: 'pw-client-0004' } }] }) });
    expect(link([[first, hit(first, 'ga4', 'a', 100)], [second, secondHit], [callReq, hit(callReq, 'meta-capi', 'x', 300)]])[2]?.hitId).toBe(secondHit.id);
  });

  test('an identity hash links a hit before the first server hit and not one after it', () => {
    const hash = hashEmail(identity.email).hex;
    const before = request('https://www.facebook.com/tr/?ud[em]=' + hash, { t: 100 });
    const after = request('https://www.facebook.com/tr/?ud[em]=' + hash, { t: 400 });
    const callReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 300, postData: JSON.stringify({ data: [{ user_data: { em: [hash] } }] }) });
    const call = hit(callReq, 'meta-capi', 'x', 300);
    const beforeHit = hit(before, 'meta', 'x', 100);
    expect(link([[before, beforeHit], [after, hit(after, 'meta', 'y', 400)], [callReq, call]])[2]).toEqual({ hitId: beforeHit.id, by: 'identity', confidence: 'probable' });
    expect(link([[after, hit(after, 'meta', 'y', 400)], [callReq, call]])[1]).toBeUndefined();
  });

  test('the plain email of the run identity links as well', () => {
    const browserReq = request('https://www.facebook.com/tr/', { t: 100, postData: `email=${encodeURIComponent(identity.email)}` });
    const callReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 300, postData: JSON.stringify({ email: identity.email }) });
    expect(link([[browserReq, hit(browserReq, 'meta', 'x', 100)], [callReq, hit(callReq, 'meta-capi', 'x', 300)]])[1]).toMatchObject({ by: 'identity' });
  });

  test('a value under 8 characters does not count', () => {
    const browserReq = request('https://www.google-analytics.com/g/collect?cid=short1', { t: 100 });
    const callReq = serverRequest('https://www.google-analytics.com/g/collect?cid=short1', { t: 300 });
    expect(link([[browserReq, hit(browserReq, 'ga4', 'a', 100)], [callReq, hit(callReq, 'ga4', 'b', 300)]])[1]).toBeUndefined();
  });

  test('no shared value gives no via', () => {
    const callReq = serverRequest('https://www.googleadservices.com/pagead/conversion/1/', { t: 300 });
    expect(link([[pixelReq, pixel], [callReq, hit(callReq, 'google-ads', 'conversion', 300)]])[1]).toBeUndefined();
  });
});
