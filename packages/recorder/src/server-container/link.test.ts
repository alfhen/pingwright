import { createIdentity, hashEmail, newId, type Hit, type Request } from '@tagreeve/core';
import { describe, expect, test } from 'vitest';
import { linkServerHits, type InFlightWindow } from './link.ts';

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

function link(pairs: Array<[Request, Hit]>, serverHosts = hosts, inFlight?: Array<[Request, InFlightWindow]>) {
  const out = linkServerHits({
    hits: pairs.map(([, h]) => h),
    requests: pairs.map(([r]) => r),
    serverHosts,
    identity,
    ...(inFlight ? { inFlight: new Map(inFlight.map(([r, w]) => [r.id, w])) } : {}),
  });
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

describe('rule 2: client ID and event name in flight', () => {
  const browserCall = (cid: string, t: number) => request(`https://sgtm.example.invalid/g/collect?cid=${cid}&en=Purchase`, { t });
  const serverCall = (cid: string, t: number) => serverRequest(`https://www.google-analytics.com/g/collect?cid=${cid}&en=Purchase`, { t });

  test('one browser hit in flight when the call arrived: exact by clientId', () => {
    const b = browserCall('pw-client-0001', 100);
    const bHit = hit(b, 'ga4', 'Purchase', 100);
    const c = serverCall('pw-client-0001', 150);
    const via = link([[b, bHit], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[1];
    expect(via).toEqual({ hitId: bHit.id, by: 'clientId', confidence: 'exact' });
  });

  test('two browser hits in flight: probable, never one of them picked as exact', () => {
    const a = browserCall('pw-client-0001', 100);
    const b = browserCall('pw-client-0001', 110);
    const c = serverCall('pw-client-0001', 150);
    const windows: Array<[Request, InFlightWindow]> = [[a, { sentAt: 100, answeredAt: 200 }], [b, { sentAt: 110, answeredAt: 200 }]];
    const via = link([[a, hit(a, 'ga4', 'Purchase', 100)], [b, hit(b, 'ga4', 'Purchase', 110)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, windows)[2];
    expect(via?.confidence).toBe('probable');
  });

  test('an earlier answered request with the same key blocks the exact link', () => {
    const a = browserCall('pw-client-0001', 100);
    const b = browserCall('pw-client-0001', 130);
    const c = serverCall('pw-client-0001', 150);
    const windows: Array<[Request, InFlightWindow]> = [[a, { sentAt: 100, answeredAt: 120 }], [b, { sentAt: 130, answeredAt: 200 }]];
    const via = link([[a, hit(a, 'ga4', 'Purchase', 100)], [b, hit(b, 'ga4', 'Purchase', 130)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, windows)[2];
    expect(via?.confidence).toBe('probable');
  });

  test('a request with the same key sent after the call is not a candidate', () => {
    const a = browserCall('pw-client-0001', 100);
    const b = browserCall('pw-client-0001', 160);
    const c = serverCall('pw-client-0001', 150);
    const aHit = hit(a, 'ga4', 'Purchase', 100);
    const windows: Array<[Request, InFlightWindow]> = [[a, { sentAt: 100, answeredAt: 200 }], [b, { sentAt: 160, answeredAt: 250 }]];
    const via = link([[a, aHit], [b, hit(b, 'ga4', 'Purchase', 160)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, windows)[2];
    expect(via).toEqual({ hitId: aHit.id, by: 'clientId', confidence: 'exact' });
  });

  test('an earlier request with no window still counts as a tie', () => {
    const a = browserCall('pw-client-0001', 100);
    const b = browserCall('pw-client-0001', 130);
    const c = serverCall('pw-client-0001', 150);
    const via = link([[a, hit(a, 'ga4', 'Purchase', 100)], [b, hit(b, 'ga4', 'Purchase', 130)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, [[b, { sentAt: 130, answeredAt: 200 }]])[2];
    expect(via?.confidence).toBe('probable');
  });

  test('two lines of one event in one request: probable', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0001', 150);
    const via = link([[b, hit(b, 'ga4', 'Purchase', 100)], [b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[2];
    expect(via?.confidence).toBe('probable');
  });

  test.each([
    ['after the answer', 200],
    ['before the request was sent', 99],
  ])('a call %s: probable', (_name, at) => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0001', at);
    const via = link([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', Math.max(at, 100))]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[1];
    expect(via?.confidence).toBe('probable');
  });

  test('a request with no recorded window is probable', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0001', 150);
    expect(link([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, [])[1]?.confidence).toBe('probable');
  });

  test('another event name never links by rule 2', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 150, postData: JSON.stringify({ data: [{ user_data: { fbp: 'pw-client-0001' } }] }) });
    const via = link([[b, hit(b, 'ga4', 'purchase', 100)], [c, hit(c, 'meta-capi', 'Purchase', 150)]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[1];
    expect(via).toMatchObject({ by: 'clientId', confidence: 'probable' });
  });

  test('a hit to a host outside serverHosts is not exact', () => {
    const b = request('https://www.google-analytics.com/g/collect?cid=pw-client-0001&en=Purchase', { t: 100 });
    const c = serverCall('pw-client-0001', 150);
    const via = link([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[1];
    expect(via?.confidence).toBe('probable');
  });

  test('a different client ID is not exact', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0009', 150);
    expect(link([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[1]).toBeUndefined();
  });

  test('rule 1 still wins over rule 2', () => {
    const b = browserCall('pw-client-0001', 100);
    const bHit = hit(b, 'ga4', 'Purchase', 100);
    const idReq = request('https://sgtm.example.invalid/g/collect?cid=pw-client-0001&en=Purchase', { t: 90 });
    const idHit = hit(idReq, 'ga4', 'Purchase', 90, { event_id: 'evt-12345678' });
    const c = serverCall('pw-client-0001', 150);
    const callHit = hit(c, 'ga4', 'Purchase', 150, { event_id: 'evt-12345678' });
    const via = link([[b, bHit], [idReq, idHit], [c, callHit]], hosts, [[b, { sentAt: 100, answeredAt: 200 }]])[2];
    expect(via).toEqual({ hitId: idHit.id, by: 'eventId', confidence: 'exact' });
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

describe('linkMiss', () => {
  const browserCall = (cid: string, t: number) => request(`https://sgtm.example.invalid/g/collect?cid=${cid}&en=Purchase`, { t });
  const serverCall = (cid: string | null, t: number) => serverRequest(`https://www.google-analytics.com/g/collect?${cid ? `cid=${cid}&` : ''}en=Purchase`, { t });
  const linked = (pairs: Array<[Request, Hit]>, inFlight?: Array<[Request, InFlightWindow]>) =>
    linkServerHits({
      hits: pairs.map(([, h]) => h),
      requests: pairs.map(([r]) => r),
      serverHosts: hosts,
      identity,
      ...(inFlight ? { inFlight: new Map(inFlight.map(([r, w]) => [r.id, w])) } : {}),
    });
  const missOf = (pairs: Array<[Request, Hit]>, inFlight?: Array<[Request, InFlightWindow]>) => linked(pairs, inFlight).map((h) => h.linkMiss);

  test('an exact link by event ID has none, and a browser hit has none', () => {
    const capiReq = serverRequest('https://graph.facebook.com/v21.0/1/events', { t: 50 });
    const capi = hit(capiReq, 'meta-capi', 'Purchase', 50, { eventId: 'evt-12345678' });
    expect(missOf([[pixelReq, pixel], [capiReq, capi]])).toEqual([undefined, undefined]);
  });

  test('an exact link by client ID has none', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0001', 150);
    expect(missOf([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]], [[b, { sentAt: 100, answeredAt: 200 }]])[1]).toBeUndefined();
  });

  test('no event ID and no client ID', () => {
    const c = serverCall(null, 150);
    expect(missOf([[c, hit(c, 'ga4', 'Purchase', 150)]])[0]).toEqual({ eventId: 'none', clientId: 'noClientId' });
  });

  test('no event name is none and noClientId', () => {
    const c = serverCall('pw-client-0001', 150);
    expect(missOf([[c, hit(c, 'ga4', null, 150, { event_id: 'evt-12345678' })]])[0]).toEqual({ eventId: 'none', clientId: 'noClientId' });
  });

  test('an event ID no browser hit carries is noMatch', () => {
    const c = serverCall(null, 150);
    expect(missOf([[pixelReq, pixel], [c, hit(c, 'ga4', 'Purchase', 150, { event_id: 'other-1234567' })]])[1]).toMatchObject({ eventId: 'noMatch' });
  });

  test('an event ID two browser hits carry is several', () => {
    const other = request('https://www.facebook.com/tr/?id=1&ev=Purchase&eid=evt-12345678', { t: 20 });
    const c = serverCall(null, 150);
    const call = hit(c, 'ga4', 'Purchase', 150, { event_id: 'evt-12345678' });
    expect(missOf([[pixelReq, pixel], [other, hit(other, 'meta', 'Purchase', 20, { eid: 'evt-12345678' })], [c, call]])[2]).toMatchObject({ eventId: 'several' });
  });

  test('a client ID no browser hit shares is noSameKeyHit', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0002', 150);
    expect(missOf([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]])[1]).toEqual({ eventId: 'none', clientId: 'noSameKeyHit' });
  });

  test('two same-key hits are severalSameKeyHits', () => {
    const a = browserCall('pw-client-0001', 100);
    const b = browserCall('pw-client-0001', 110);
    const c = serverCall('pw-client-0001', 150);
    const windows: Array<[Request, InFlightWindow]> = [[a, { sentAt: 100, answeredAt: 200 }], [b, { sentAt: 110, answeredAt: 200 }]];
    expect(missOf([[a, hit(a, 'ga4', 'Purchase', 100)], [b, hit(b, 'ga4', 'Purchase', 110)], [c, hit(c, 'ga4', 'Purchase', 150)]], windows)[2]).toEqual({ eventId: 'none', clientId: 'severalSameKeyHits' });
  });

  test('one same-key hit answered before the call is answeredBefore, and keeps its probable via', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0001', 250);
    const call = linked([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 250)]], [[b, { sentAt: 100, answeredAt: 200 }]])[1];
    expect(call?.linkMiss).toEqual({ eventId: 'none', clientId: 'answeredBefore' });
    expect(call?.via).toMatchObject({ confidence: 'probable' });
  });

  test('one same-key hit with no window is answeredBefore', () => {
    const b = browserCall('pw-client-0001', 100);
    const c = serverCall('pw-client-0001', 150);
    expect(missOf([[b, hit(b, 'ga4', 'Purchase', 100)], [c, hit(c, 'ga4', 'Purchase', 150)]])[1]).toMatchObject({ clientId: 'answeredBefore' });
  });

  test('the reason holds no ID or value', () => {
    const c = serverCall('pw-client-0001', 150);
    const h = hit(c, 'ga4', 'Purchase', 150, { event_id: 'evt-12345678' });
    expect(JSON.stringify([c, h])).toContain('pw-client-0001');
    expect(JSON.stringify([c, h])).toContain('evt-12345678');
    const miss = missOf([[c, h]]);
    expect(miss).toBeDefined();
    const text = JSON.stringify(miss);
    expect(text).not.toContain('pw-client');
    expect(text).not.toContain('evt-');
  });
});
