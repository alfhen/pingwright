import { createIdentity, type Request } from '@pingwright/core';
import { parseScenario } from '@pingwright/expect';
import { expect, test } from 'vitest';
import { isLoopbackHost, isSensitiveField } from './guard.ts';
import { defaultCartCheck, fillValue, hasHandoff, recordScenario, resolveSitePath } from './steps.ts';

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

test('hasHandoff is true only for a scenario with a handoff step', () => {
  expect(hasHandoff(parseScenario('start: /\nsteps:\n  - click: a\n'))).toBe(false);
  expect(hasHandoff(parseScenario('start: /\nsteps:\n  - click: a\n  - handoff: Pay\n'))).toBe(true);
});

test('a scenario with a handoff launches headed and one without does not', async () => {
  const launched: (boolean | undefined)[] = [];
  const launch = (options: { headed?: boolean }) => {
    launched.push(options.headed);
    return Promise.reject(new Error('stop'));
  };
  const base = { networkMode: 'stub' as const, outDir: 'unused', site: 'http://localhost', launch: launch as never };
  await recordScenario({ ...base, parsed: parseScenario('start: /\nsteps:\n  - handoff: Pay\n') }).catch(() => undefined);
  await recordScenario({ ...base, parsed: parseScenario('start: /\n') }).catch(() => undefined);
  expect(launched).toEqual([true, false]);
});

const request = (over: Partial<Request>): Request =>
  ({ method: 'GET', url: 'http://localhost/', postData: null, ...over }) as Request;
const dl = (event: string | null) => ({ event }) as never;

test('the default cart check wants a cart POST, a cart mutation or an add_to_cart event', () => {
  const check = (requests: Request[], events: ReturnType<typeof dl>[] = []) => defaultCartCheck({ requests, dataLayerEvents: events });
  expect(check([])).toBe(false);
  expect(check([request({ url: 'https://shop.example.com/cart.js' })])).toBe(false);
  expect(check([request({ method: 'POST', url: 'https://shop.example.com/cart/add.js' })])).toBe(true);
  expect(check([request({ method: 'POST', url: 'https://shop.example.com/api/graphql', postData: '{"query":"mutation { cartLinesAdd }"}' })])).toBe(true);
  expect(check([], [dl('page_view')])).toBe(false);
  expect(check([], [dl('add_to_cart')])).toBe(true);
});
