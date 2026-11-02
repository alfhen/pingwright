import { expect, test } from 'vitest';
import { PAYMENT_PROVIDERS, canonicalCard, findPaymentProvider } from './payment-providers.ts';

test('the table lists the three providers with documented values', () => {
  expect(PAYMENT_PROVIDERS.map((p) => p.id)).toEqual(['shopify-bogus', 'shopify-test', 'fixture']);
  expect(findPaymentProvider('shopify-bogus')?.cards).toEqual(['1', '2', '3']);
  for (const p of PAYMENT_PROVIDERS) {
    expect(p.docs).toMatch(/^https:\/\//);
    expect(p.cards.length).toBeGreaterThan(0);
  }
});

test('only the fixture provider is loopback only', () => {
  expect(PAYMENT_PROVIDERS.filter((p) => p.loopbackOnly).map((p) => p.id)).toEqual(['fixture']);
});

test('a card value outside the list has no canonical form', () => {
  const bogus = findPaymentProvider('shopify-bogus')!;
  expect(canonicalCard(bogus, '1')).toBe('1');
  expect(canonicalCard(bogus, '4')).toBeUndefined();
  expect(canonicalCard(bogus, '')).toBeUndefined();
  const test_ = findPaymentProvider('shopify-test')!;
  expect(canonicalCard(test_, '4242-4242 4242-4242')).toBe('4242424242424242');
  expect(canonicalCard(test_, '4242424242424241')).toBeUndefined();
});
