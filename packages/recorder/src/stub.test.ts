import { expect, test } from 'vitest';
import { stubResponse } from './stub.ts';

test('fetch, xhr and ping get 204 with CORS that echoes the origin and allows credentials', () => {
  for (const resourceType of ['fetch', 'xhr', 'ping']) {
    const stub = stubResponse({ resourceType, headers: { origin: 'https://shop.example.com' } });
    expect(stub.status).toBe(204);
    expect(stub.body).toBeUndefined();
    expect(stub.headers['access-control-allow-origin']).toBe('https://shop.example.com');
    expect(stub.headers['access-control-allow-credentials']).toBe('true');
  }
});

test('images get a 1x1 GIF', () => {
  const stub = stubResponse({ resourceType: 'image', headers: {} });
  expect(stub.status).toBe(200);
  expect(stub.headers['content-type']).toBe('image/gif');
  expect(stub.body?.subarray(0, 6).toString('ascii')).toBe('GIF89a');
});

test('an opaque origin is echoed as null', () => {
  const stub = stubResponse({ resourceType: 'fetch', headers: { origin: 'null' } });
  expect(stub.headers['access-control-allow-origin']).toBe('null');
});

test('requested headers are allowed', () => {
  const stub = stubResponse({
    resourceType: 'fetch',
    headers: { origin: 'https://a.example.com', 'access-control-request-headers': 'content-type' },
  });
  expect(stub.headers['access-control-allow-headers']).toBe('content-type');
});
