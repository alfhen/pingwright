import { expect, test } from 'vitest';
import { isKnownVendorCollection, stubResponse } from './stub.ts';

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

test('scripts and documents get an empty 200', () => {
  const script = stubResponse({ resourceType: 'script', headers: {} });
  expect(script.status).toBe(200);
  expect(script.headers['content-type']).toBe('application/javascript');
  expect(script.body?.length).toBe(0);
  const doc = stubResponse({ resourceType: 'document', headers: {} });
  expect(doc.status).toBe(200);
  expect(doc.headers['content-type']).toBe('text/html');
  expect(doc.body?.length).toBe(0);
});

test('Meta and Google ad collection paths are stubbed for every resource type', () => {
  for (const url of [
    'https://www.facebook.com/tr/?id=100000000000001',
    'https://pagead2.googlesyndication.com/ccm/collect?x=1',
    'https://www.googleadservices.com/pagead/conversion/1/',
    'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/000000001/?en=purchase',
    'https://www.google.com/pagead/1p-user-list/000000001/?x=1',
    'https://www.google.com/rmkt/collect/000000001/?en=purchase',
    'https://ad.doubleclick.net/ccm/s/collect?fmt=8',
    'https://td.doubleclick.net/td/rul/000000001',
  ]) {
    for (const resourceType of ['fetch', 'image', 'script', 'document']) {
      expect(isKnownVendorCollection({ url, resourceType }), `${resourceType} ${url}`).toBe(true);
    }
  }
});

test('library loads continue', () => {
  for (const url of [
    'https://connect.facebook.net/en_US/fbevents.js',
    'https://connect.facebook.net/signals/config/100000000000001?v=2',
    'https://www.googleadservices.com/gtag/js?id=AW-000000001',
  ]) {
    expect(isKnownVendorCollection({ url, resourceType: 'script' }), url).toBe(false);
  }
  expect(isKnownVendorCollection({ url: 'https://www.facebook.com/', resourceType: 'document' })).toBe(false);
  expect(isKnownVendorCollection({ url: 'https://www.google.com/recaptcha/api2/reload?k=x', resourceType: 'xhr' })).toBe(false);
  expect(isKnownVendorCollection({ url: 'https://www.google.com/maps/vt?pb=1', resourceType: 'image' })).toBe(false);
  expect(isKnownVendorCollection({ url: 'https://example.com/tr/', resourceType: 'fetch' })).toBe(false);
});
