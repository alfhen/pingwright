import { expect, test } from 'vitest';
import { platformHostDocsDomains, platformHostFor, platformHosts, type PlatformHostEntry } from './index.ts';

const list: PlatformHostEntry[] = [
  { platform: 'shopify', host: 'telemetry.example.invalid', purpose: 'telemetry', source: 'https://shopify.dev/x' },
  { platform: 'shopify', host: '*.pay.example.invalid', paths: ['/checkout'], purpose: 'checkout', source: 'https://shopify.dev/y' },
];
const at = (url: string) => platformHostFor({ url }, list)?.purpose;

test('matches an exact host on any path', () => {
  expect(at('https://telemetry.example.invalid/v1/produce')).toBe('telemetry');
});

test('matches a wildcard subdomain only on a listed path', () => {
  expect(at('https://a.pay.example.invalid/checkout/x')).toBe('checkout');
  expect(at('https://a.pay.example.invalid/other')).toBeUndefined();
  expect(at('https://pay.example.invalid/checkout')).toBeUndefined();
});

test('does not match lookalike hosts or bad URLs', () => {
  expect(at('https://telemetry.example.invalid.evil.invalid/')).toBeUndefined();
  expect(at('not a url')).toBeUndefined();
});

test('the built-in list matches its own entries', () => {
  expect(platformHostFor({ url: 'https://cdn.shopify.com/s/files/x.js' })?.platform).toBe('shopify');
  expect(platformHostFor({ url: 'https://other.shopify.com/' })).toBeUndefined();
});

test('every source is https on the platform docs domains', () => {
  expect(platformHosts.length).toBeGreaterThan(0);
  for (const e of platformHosts) {
    const u = new URL(e.source);
    const ok = platformHostDocsDomains[e.platform]!.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
    expect(u.protocol, e.source).toBe('https:');
    expect(ok, `${e.platform}: ${e.source}`).toBe(true);
  }
});

test('the Shop Pay hosts match with their purposes', () => {
  const purpose = (url: string) => platformHostFor({ url })?.purpose;
  expect(purpose('https://pay.shopify.com/x')).toBe('payments');
  expect(purpose('https://shop.app/x')).toBe('payments');
  expect(purpose('https://cdn.shopifycloud.com/x.js')).toBe('cdn');
  expect(purpose('https://otlp-http-production.shopifysvc.com/v1/traces')).toBe('telemetry');
});

test('monorail-edge keeps its own source ahead of the shopifysvc wildcard', () => {
  expect(platformHostFor({ url: 'https://monorail-edge.shopifysvc.com/v1/produce' })?.source).toBe('https://shopify.dev/docs/storefronts/headless/hydrogen/analytics/validation');
});

test('lookalikes of the Shop Pay hosts do not match', () => {
  for (const url of ['https://shopifysvc.com/', 'https://evilshopifysvc.com/', 'https://pay.shopify.com.evil.test/', 'https://js.stripe.com/v3/']) {
    expect(platformHostFor({ url }), url).toBeUndefined();
  }
});

test('third-party payment hosts are not listed', () => {
  for (const url of ['https://js.stripe.com/v3/', 'https://www.paypal.com/sdk/js', 'https://x.klarna.com/y']) {
    expect(platformHostFor({ url })).toBeUndefined();
  }
});
