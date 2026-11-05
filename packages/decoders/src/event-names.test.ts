import { expect, test } from 'vitest';
import { ga4EventName, SHOPIFY_TO_GA4 } from './event-names.ts';

test('a Shopify standard name maps to its GA4 name', () => {
  expect(ga4EventName('checkout_completed')).toBe('purchase');
  expect(ga4EventName('product_added_to_cart')).toBe('add_to_cart');
  expect(ga4EventName('search_submitted')).toBe('search');
});

test('other names, including GA4 names and object prototype keys, stay as they are', () => {
  expect(ga4EventName('purchase')).toBe('purchase');
  expect(ga4EventName('custom_event')).toBe('custom_event');
  expect(ga4EventName('constructor')).toBe('constructor');
  expect(ga4EventName('__proto__')).toBe('__proto__');
});

test('no table value is itself a key, so mapping twice changes nothing', () => {
  for (const to of Object.values(SHOPIFY_TO_GA4)) expect(Object.hasOwn(SHOPIFY_TO_GA4, to)).toBe(false);
});
