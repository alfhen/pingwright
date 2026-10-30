import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest } from './index.ts';

function req(url: string, over: Partial<Request> = {}): Request {
  return {
    type: 'request',
    id: newId('request'),
    runId: newId('run'),
    stepId: null,
    t: 1_800_000_000_000,
    method: 'GET',
    url,
    resourceType: 'fetch',
    frameUrl: 'http://localhost:3000/thank-you',
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
    ...over,
  };
}

const dtdc = (o: object) => encodeURIComponent(Buffer.from(JSON.stringify(o)).toString('base64'));
const HASH = 'a'.repeat(64);

test('reads user_data fields from dtdc as user_data.<field> params', () => {
  const body = {
    event_name: 'purchase',
    page_location: 'http://localhost:3000/thank-you',
    user_data: { email_address: HASH, first_name: HASH, address: { city: HASH, postal_code: 'x' } },
  };
  const [hit] = decodeRequest(req(`https://sgtm.example.com/data?v=2&tid=G-PWTEST0001&dtdc=${dtdc(body)}`));
  expect(hit?.vendor).toBe('sgtm');
  expect(hit?.params).toMatchObject({
    'user_data.email_address': HASH,
    'user_data.first_name': HASH,
    'user_data.city': HASH,
    'user_data.postal_code': 'x',
  });
});

test('reads user_data from a POST body and ignores non-string values', () => {
  const postData = JSON.stringify({
    event_name: 'purchase',
    page_location: 'http://localhost:3000/',
    user_data: { phone_number: HASH, last_name: 5 },
  });
  const [hit] = decodeRequest(req('https://sgtm.example.com/data?v=2', { method: 'POST', postData }));
  expect(hit?.params['user_data.phone_number']).toBe(HASH);
  expect(hit?.params['user_data.last_name']).toBeUndefined();
});

test('a hit without user_data has no user_data params', () => {
  const body = { event_name: 'page_view', page_location: 'http://localhost:3000/' };
  const [hit] = decodeRequest(req(`https://sgtm.example.com/data?v=2&dtdc=${dtdc(body)}`));
  expect(Object.keys(hit!.params).some((k) => k.startsWith('user_data.'))).toBe(false);
});
