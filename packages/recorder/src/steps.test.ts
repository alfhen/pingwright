import { createIdentity, type Request } from '@pingwright/core';
import { parseScenario } from '@pingwright/expect';
import { describe, expect, test } from 'vitest';
import { isLoopbackHost, isSensitiveField } from './guard.ts';
import { createCartCheck, fillValue, hasHandoff, playScenario, recordScenario, resolveSitePath } from './steps.ts';

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

describe('the default cart check', () => {
  const check = (
    requests: Request[],
    events: ReturnType<typeof dl>[] = [],
    responses: { requestId: string; status: number }[] = requests.map((r) => ({ requestId: r.id, status: 200 })),
    pattern?: string,
  ) => createCartCheck(pattern)({ requests, responses: responses as never, dataLayerEvents: events });

  test('wants a cart write, a cart mutation or an add_to_cart event', () => {
    expect(check([])).toBe(false);
    expect(check([request({ url: 'https://shop.example.com/cart.js' })])).toBe(false);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/cart.js' })])).toBe(false);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/cart/add.js' })])).toBe(true);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/cart/clear' })])).toBe(false);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/api/graphql', postData: '{"query":"mutation { cartLinesAdd }"}' })])).toBe(true);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/api/graphql', postData: '{"query":"mutation { cartCreate }"}' })])).toBe(true);
    expect(check([], [dl('page_view')])).toBe(false);
    expect(check([], [dl('add_to_cart')])).toBe(true);
  });

  test('knows WooCommerce, Magento, Hydrogen and GET adds', () => {
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/?wc-ajax=add_to_cart' })])).toBe(true);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/checkout/cart/add/uenc/abc/product/7/' })])).toBe(true);
    expect(check([request({ method: 'POST', url: 'https://shop.example.com/cart' })])).toBe(true);
    expect(check([request({ method: 'GET', url: 'https://shop.example.com/cart' })])).toBe(false);
    expect(check([request({ method: 'GET', url: 'https://shop.example.com/cart/add?id=7' })])).toBe(true);
    expect(check([request({ method: 'GET', url: 'https://shop.example.com/cart/change?id=7' })])).toBe(false);
  });

  test('wants a recorded 2xx response', () => {
    const add = request({ id: 'req_1' as Request['id'], method: 'POST', url: 'https://shop.example.com/cart/add.js' });
    expect(check([add], [], [{ requestId: 'req_1', status: 422 }])).toBe(false);
    expect(check([add], [], [{ requestId: 'req_1', status: 200 }])).toBe(true);
    expect(check([add], [], [{ requestId: 'req_1', status: 302 }])).toBe(true);
    expect(check([add], [], [{ requestId: 'req_1', status: 500 }])).toBe(false);
    expect(check([add], [], [])).toBe(false);
    expect(check([add], [], [{ requestId: 'other', status: 200 }])).toBe(false);
  });

  test('takes a scenario pattern on top', () => {
    const custom = request({ method: 'POST', url: 'https://shop.example.com/api/basket/items' });
    expect(check([custom])).toBe(false);
    expect(check([custom], [], undefined, '/api/basket/')).toBe(true);
  });
});

test('a StepError from a run with a GTM override does not repeat the gtmAuth', async () => {
  const auth = 'pwfake-auth-0001';
  const recorder = {
    site: 'http://localhost',
    setIdentity: () => undefined,
    beginStep: () => ({}),
    endStep: () => undefined,
    close: () => Promise.resolve({ path: 'unused', records: {} }),
    context: { pages: () => [{ goto: () => Promise.reject(new Error(`page.goto: net::ERR_FAILED at http://localhost/?gtm_auth=${auth}`)) }] },
  };
  const options = {
    networkMode: 'stub' as const,
    outDir: 'unused',
    site: 'http://localhost',
    parsed: parseScenario('start: /\n'),
    launch: (() => Promise.resolve(recorder)) as never,
  };
  const failure = (o: Parameters<typeof recordScenario>[0]) =>
    recordScenario(o).then(
      () => new Error('no error'),
      (e: Error) => e,
    );
  const plain = await failure(options);
  expect(plain.message).toContain(auth);
  const scrubbed = await failure({ ...options, gtmOverride: { container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: 'env-99' } });
  expect(scrubbed.name).toBe('StepError');
  expect(scrubbed.message).not.toContain(auth);
  expect(scrubbed.stack ?? '').not.toContain(auth);
});

test('a value typed into a password field by any selector is not kept in the run identity', async () => {
  const saved: unknown[] = [];
  const locator = (type: string) => ({
    first: () => ({
      evaluate: () => Promise.resolve({ tag: 'input', host: 'localhost', fields: [{ autocomplete: null, name: 'pass', id: 'x', type }] }),
      fill: () => Promise.resolve(),
    }),
  });
  const page = {
    goto: () => Promise.resolve(),
    locator: (selector: string) => locator(selector === '#pw' ? 'password' : 'text'),
  };
  const recorder = {
    site: 'http://localhost',
    setIdentity: (i: unknown) => saved.push(structuredClone(i)),
    beginStep: () => ({}),
    endStep: () => undefined,
    checkpoint: () => Promise.resolve(),
    context: { pages: () => [page] },
  };
  const scenario = parseScenario('start: /\nsteps:\n  - fill:\n      "#pw": secret-fake-value\n      "#note": Berlin\n');
  const identity = await playScenario(recorder as never, scenario, { seed: 1 });
  expect(identity.extra).toEqual(['Berlin']);
  expect(JSON.stringify(saved.at(-1))).not.toContain('secret-fake-value');
});

test('a password value is never saved in the identity when the run fails at or before the fill', async () => {
  const saved: unknown[] = [];
  const page = (host: string, clickFails: boolean) => ({
    goto: () => Promise.resolve(),
    locator: (selector: string) => ({
      first: () => ({
        click: () => (clickFails ? Promise.reject(new Error('click timeout')) : Promise.resolve()),
        evaluate: () =>
          Promise.resolve({ tag: 'input', host, fields: [{ autocomplete: null, name: 'pass', id: 'x', type: selector === '#pw' ? 'password' : 'text' }] }),
        fill: () => Promise.resolve(),
      }),
    }),
  });
  const play = (host: string, clickFails: boolean, yaml: string) => {
    const recorder = {
      site: `https://${host}`,
      setIdentity: (i: unknown) => saved.push(structuredClone(i)),
      beginStep: () => ({}),
      endStep: () => undefined,
      checkpoint: () => Promise.resolve(),
      context: { pages: () => [page(host, clickFails)] },
    };
    return playScenario(recorder as never, parseScenario(yaml), { seed: 1 });
  };
  await expect(play('shop.example.com', false, 'start: /\nsteps:\n  - fill:\n      "#pw": secret-fake-value\n')).rejects.toThrow(/password field/);
  await expect(
    play('localhost', true, 'start: /\nsteps:\n  - click: "#go"\n  - fill:\n      "#pw": secret-fake-value\n'),
  ).rejects.toThrow(/click timeout/);
  expect(saved.length).toBeGreaterThan(0);
  expect(JSON.stringify(saved)).not.toContain('secret-fake-value');
});
