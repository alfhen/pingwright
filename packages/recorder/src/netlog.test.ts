import { expect, test } from 'vitest';
import { parseNetLog } from './netlog.ts';

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

test('reads a log that stops after the last event', () => {
  const text = JSON.stringify({ constants, events }).replace(/\]\}$/, '');
  expect(parseNetLog(text)).toHaveLength(2);
});
