import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { newId, type Request, type Step } from '@pingwright/core';
import { decodeRequest, trackerList } from '@pingwright/decoders';
import { mergeNetLog, parseNetLog, watchNetLogDir, type NetLogRequest } from './netlog.ts';

const constants = {
  logEventTypes: { URL_REQUEST_START_JOB: 1, HTTP_TRANSACTION_SEND_REQUEST_HEADERS: 2, HTTP_TRANSACTION_READ_RESPONSE_HEADERS: 3, REQUEST_ALIVE: 4 },
  netError: { ERR_NAME_NOT_RESOLVED: -105 },
  timeTickOffset: '1000000',
};

const ev = (type: number, id: number, time: number, params?: Record<string, unknown>) => ({ type, time: String(time), source: { id }, params });

const events = [
  ev(1, 7, 500, { url: 'https://sgtm.pingwright.invalid/g/collect?v=2&en=add_to_cart', method: 'POST' }),
  ev(2, 7, 501, { headers: ['Host: sgtm.pingwright.invalid', 'Content-Type: text/plain'] }),
  ev(3, 7, 510, { headers: ['HTTP/1.1 200 OK', 'a: b'] }),
  ev(1, 8, 600, { url: 'https://x.pingwright.invalid/p', method: 'GET' }),
  ev(4, 8, 601, { net_error: -105 }),
  ev(4, 9, 602, { net_error: -105 }),
];

test('reads URL, method, headers, status and network error per request', () => {
  const text = JSON.stringify({ constants, events });
  expect(parseNetLog(text)).toEqual([
    {
      t: 1000500,
      method: 'POST',
      url: 'https://sgtm.pingwright.invalid/g/collect?v=2&en=add_to_cart',
      headers: { host: 'sgtm.pingwright.invalid', 'content-type': 'text/plain' },
      status: 200,
      failure: null,
    },
    { t: 1000600, method: 'GET', url: 'https://x.pingwright.invalid/p', headers: {}, status: null, failure: 'net::ERR_NAME_NOT_RESOLVED' },
  ]);
});

test('skips CORS preflights', () => {
  const preflight = [ev(1, 20, 700, { url: 'https://sgtm.pingwright.invalid/g/collect', method: 'OPTIONS' }), ev(3, 20, 710, { headers: ['HTTP/1.1 204 No Content'] })];
  expect(parseNetLog(JSON.stringify({ constants, events: preflight }))).toEqual([]);
});

test('reads a log that stops after the last event', () => {
  const text = JSON.stringify({ constants, events }).replace(/\]\}$/, '');
  expect(parseNetLog(text)).toHaveLength(2);
});

const runId = newId('run');
const GA4 = 'https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&en=add_to_cart';

const step = (startedAt: number): Step => ({ type: 'step', id: newId('step'), runId, index: 0, label: 's', startedAt, endedAt: null });
const entry = (over: Partial<NetLogRequest> = {}): NetLogRequest => ({ t: 1000, method: 'POST', url: GA4, headers: {}, status: 204, failure: null, ...over });
const recordedRequest = (over: Partial<Request> = {}): Request => ({ type: 'request', id: newId('request'), runId, stepId: null, t: 900, method: 'POST', url: GA4, resourceType: 'ping', frameUrl: null, headers: {}, postData: null, outcome: 'stubbed', ...over }) as Request;
const merge = (entries: NetLogRequest[], recorded: Request[] = [], steps: Step[] = [], navigations: number[] = []) =>
  mergeNetLog(entries, recorded, steps, trackerList, runId, navigations);

test('skips an entry that a recorded request already accounts for', () => {
  expect(merge([entry()], [recordedRequest()]).requests).toEqual([]);
});

test('two identical entries with one recorded request add one request', () => {
  expect(merge([entry(), entry({ t: 1001 })], [recordedRequest()]).requests).toHaveLength(1);
});

test('drops a URL that is not a collection endpoint', () => {
  expect(merge([entry({ url: 'https://example.com/page' })]).requests).toEqual([]);
});

test('takes the step from the latest step that started before the entry', () => {
  const early = step(500);
  const late = step(900);
  const after = step(2000);
  expect(merge([entry({ t: 1000 })], [], [early, late, after]).requests[0]?.stepId).toBe(late.id);
  expect(merge([entry({ t: 100 })], [], [early]).requests[0]?.stepId).toBeNull();
});

test('a network failure gives outcome failed and no response', () => {
  const { requests, responses } = merge([entry({ status: null, failure: 'ERR_ABORTED' })]);
  expect(requests[0]).toMatchObject({ outcome: 'failed', failure: 'ERR_ABORTED', captured: 'netlog', initiator: 'netlog' });
  expect(responses).toEqual([]);
});

test('a status adds a passed request and a response', () => {
  const { requests, responses } = merge([entry({ status: 200 })]);
  expect(requests[0]).toMatchObject({ outcome: 'passed' });
  expect(responses).toEqual([expect.objectContaining({ requestId: requests[0]!.id, status: 200 })]);
});

test('redacts cookie and authorization headers', () => {
  const headers = { cookie: 'a=b', authorization: 'x', accept: '*/*' };
  expect(merge([entry({ headers })]).requests[0]?.headers).toEqual({ cookie: '[redacted]', authorization: '[redacted]', accept: '*/*' });
});

test('the added GA4 request decodes to an add_to_cart hit', () => {
  const [request] = merge([entry()]).requests;
  const hits = decodeRequest(request!, undefined, trackerList);
  expect(hits.map((h) => h.event)).toContain('add_to_cart');
});

test('an OPTIONS entry is not added', () => {
  expect(merge([entry({ method: 'OPTIONS' })]).requests).toEqual([]);
});

test('initiator is unload only shortly after a top-level navigation began', () => {
  expect(merge([entry({ t: 1000 })], [], [], [900]).requests[0]?.initiator).toBe('unload');
  expect(merge([entry({ t: 1000 })], [], [], [1200]).requests[0]?.initiator).toBe('netlog');
  expect(merge([entry({ t: 100000 })], [], [], [900]).requests[0]?.initiator).toBe('netlog');
  expect(merge([entry()]).requests[0]?.initiator).toBe('netlog');
});

test('watchNetLogDir removes the directory on demand and on exit handlers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-netlog-test-'));
  await writeFile(join(dir, 'netlog.json'), '{}');
  const before = process.listenerCount('exit');
  const remove = watchNetLogDir(dir);
  expect(process.listenerCount('exit')).toBe(before + 1);
  remove();
  expect(existsSync(dir)).toBe(false);
  expect(process.listenerCount('exit')).toBe(before);
});
