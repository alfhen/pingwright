import { createIdentity } from '@pingwright/core';
import { expect, test } from 'vitest';
import { isLoopbackHost, isSensitiveField } from './guard.ts';
import { fillValue, resolveSitePath } from './steps.ts';

const field = (over: Partial<Parameters<typeof isSensitiveField>[0]> = {}) => ({
  autocomplete: null,
  name: null,
  id: null,
  type: null,
  ...over,
});

test('only loopback hosts are loopback', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
  for (const host of ['example.com', 'localhost.example.com', '127.0.0.2', '10.0.0.1', '0.0.0.0', 'shop.localhost.com', '']) {
    expect(isLoopbackHost(host)).toBe(false);
  }
});

test('card and password fields are sensitive', () => {
  expect(isSensitiveField(field({ autocomplete: 'cc-number' }))).toBe(true);
  expect(isSensitiveField(field({ autocomplete: 'section-pay cc-csc' }))).toBe(true);
  expect(isSensitiveField(field({ type: 'password' }))).toBe(true);
  expect(isSensitiveField(field({ name: 'cardNumber' }))).toBe(true);
  expect(isSensitiveField(field({ id: 'CVV' }))).toBe(true);
  expect(isSensitiveField(field({ name: 'iban' }))).toBe(true);
  expect(isSensitiveField(field({ id: 'user-password' }))).toBe(true);
});

test('ordinary fields are not sensitive', () => {
  expect(isSensitiveField(field({ autocomplete: 'email', name: 'email', id: 'email', type: 'email' }))).toBe(false);
  expect(isSensitiveField(field({ autocomplete: 'address-line1', id: 'address1' }))).toBe(false);
  expect(isSensitiveField(field())).toBe(false);
});

test('fill uses identity fields by name and other values as written', () => {
  const identity = createIdentity(7);
  expect(fillValue('email', identity)).toBe(identity.email);
  expect(fillValue('country', identity)).toBe('US');
  expect(fillValue('SE', identity)).toBe('SE');
  expect(fillValue('4242424242424242', identity)).toBe('4242424242424242');
});

test('visit paths resolve against the site with vars and cannot leave it', () => {
  expect(resolveSitePath('/products/{p}', 'http://localhost:3000', { p: 'tee' })).toBe('http://localhost:3000/products/tee');
  expect(resolveSitePath('cart', 'http://localhost:3000/shop/', {})).toBe('http://localhost:3000/shop/cart');
  expect(() => resolveSitePath('https://elsewhere.example.com/', 'http://localhost:3000', {})).toThrow(/leaves the site/);
  expect(() => resolveSitePath('//elsewhere.example.com/', 'http://localhost:3000', {})).toThrow(/leaves the site/);
});
