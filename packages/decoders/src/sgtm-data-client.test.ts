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

const post = (body: object) =>
  decodeRequest(req('https://sgtm.example.com/data?v=2&event=purchase', { method: 'POST', postData: JSON.stringify(body) }))[0];

test('reads Data Tag fields at the top level of the body when there is no user_data object', () => {
  const hit = post({
    event_name: 'purchase',
    email_address: HASH,
    first_name: HASH,
    last_name: HASH,
    phone_number: '',
    street: HASH,
    city: HASH,
    postal_code: 'x',
    country: 'DE',
    external_id: HASH,
  });
  expect(hit?.params).toMatchObject({
    'user_data.email_address': HASH,
    'user_data.first_name': HASH,
    'user_data.last_name': HASH,
    'user_data.street': HASH,
    'user_data.city': HASH,
    'user_data.postal_code': 'x',
    'user_data.country': 'DE',
  });
  expect(hit?.params['user_data.phone_number']).toBeUndefined();
});

test('prefers the user_data object over top-level fields', () => {
  const other = 'b'.repeat(64);
  const hit = post({ event_name: 'purchase', email_address: other, city: other, user_data: { email_address: HASH } });
  expect(hit?.params['user_data.email_address']).toBe(HASH);
  expect(hit?.params['user_data.city']).toBeUndefined();
});

test('reads the first object of an address list and the first string of email and phone lists', () => {
  const other = 'b'.repeat(64);
  const hit = post({
    event_name: 'purchase',
    user_data: {
      email_address: [HASH, other],
      phone_number: ['', other],
      address: [{ city: HASH, postal_code: 'x' }, { city: other }],
    },
  });
  expect(hit?.params).toMatchObject({
    'user_data.email_address': HASH,
    'user_data.phone_number': other,
    'user_data.city': HASH,
    'user_data.postal_code': 'x',
  });
});

test('does not expose a region field as user_data.region', () => {
  const top = post({ event_name: 'purchase', region: 'BE', city: HASH });
  expect(top?.params['user_data.region']).toBeUndefined();
  const nested = post({ event_name: 'purchase', user_data: { address: { region: 'BE', city: HASH } } });
  expect(nested?.params['user_data.region']).toBeUndefined();
});
