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

test('a scenario with a handoff launches headed with the Done control and one without does not', async () => {
  const launched: (boolean | undefined)[] = [];
  const overlay: (boolean | undefined)[] = [];
  const launch = (options: { headed?: boolean; handoffOverlay?: boolean }) => {
    launched.push(options.headed);
    overlay.push(options.handoffOverlay);
    return Promise.reject(new Error('stop'));
  };
  const base = { networkMode: 'stub' as const, outDir: 'unused', site: 'http://localhost', launch: launch as never };
  await recordScenario({ ...base, parsed: parseScenario('start: /\nsteps:\n  - handoff: Pay\n') }).catch(() => undefined);
  await recordScenario({ ...base, parsed: parseScenario('start: /\n') }).catch(() => undefined);
  expect(launched).toEqual([true, false]);
  expect(overlay).toEqual([true, false]);
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

describe('select and locator steps on a fake page', () => {
  const options = [
    { value: '', label: 'Choose' },
    { value: 'DE', label: 'Germany' },
    { value: 'SE', label: 'Sweden' },
  ];
  const selectPage = (host: string, over: { autocomplete?: string; stays?: number } = {}) => {
    let selected = 0;
    const field = {
      evaluate: (fn: (el: unknown) => unknown) => {
        const source = fn.toString();
        if (source.includes('tagName')) {
          return Promise.resolve({ tag: 'select', host, fields: [{ autocomplete: over.autocomplete ?? null, name: 'countryCode', id: null, type: null }] });
        }
        if (source.includes('selectedIndex')) return Promise.resolve({ index: selected, label: options[selected]!.label });
        return Promise.resolve(options);
      },
      selectOption: (arg: { index: number }) => {
        selected = over.stays ?? arg.index;
        return Promise.resolve([]);
      },
    };
    return { goto: () => Promise.resolve(), locator: () => ({ first: () => field }) };
  };
  const play = (page: unknown, yaml: string, extras: Partial<Record<string, unknown>> = {}) => {
    const saved: { extra?: string[] }[] = [];
    const recorder = {
      site: 'https://shop.example.com',
      setIdentity: (i: { extra?: string[] }) => saved.push(structuredClone(i)),
      beginStep: () => ({}),
      endStep: () => undefined,
      checkpoint: () => Promise.resolve(),
      context: { pages: () => [page] },
      ...extras,
    };
    return playScenario(recorder as never, parseScenario(yaml), { seed: 1 }).then((identity) => ({ identity, saved }));
  };
  const select = (value: string) => `start: /\nsteps:\n  - select: { "select[name=countryCode]": ${value} }\n`;

  test('chooses by value, then by label, and adds both to the run identity extras', async () => {
    const byValue = await play(selectPage('shop.example.com'), select('DE'));
    expect(byValue.identity.extra).toEqual(['DE', 'Germany']);
    const byLabel = await play(selectPage('shop.example.com'), select('Sweden'));
    expect(byLabel.identity.extra).toEqual(['SE', 'Sweden']);
    expect(byLabel.saved.at(-1)?.extra).toEqual(['SE', 'Sweden']);
  });

  test('fails when no option matches and when the value is not applied', async () => {
    await expect(play(selectPage('shop.example.com'), select('FR'))).rejects.toThrow(/no option with value or label "FR"/);
    await expect(play(selectPage('shop.example.com', { stays: 0 }), select('DE'))).rejects.toThrow('value not applied (still: Choose)');
  });

  test('a card select is refused on a hosted host and allowed on a loopback host', async () => {
    const card = { autocomplete: 'cc-exp-month' };
    await expect(play(selectPage('shop.example.com', card), select('DE'))).rejects.toThrow(/card or password field. Payments and log-ins must be handoff/);
    const local = await play(selectPage('localhost', card), select('DE'));
    expect(local.identity.extra).toBeUndefined();
  });

  test('an any locator records the index used, and a role locator maps to getByRole', async () => {
    const records: { locator?: number }[] = [];
    const clicked: string[] = [];
    const page = {
      goto: () => Promise.resolve(),
      locator: (selector: string) => ({
        count: () => Promise.resolve(selector === 'text=Two' ? 1 : 0),
        first: () => ({ click: () => (clicked.push(selector), Promise.resolve()) }),
      }),
      getByRole: (role: string, o: { name: string }) => ({ first: () => ({ click: () => (clicked.push(`${role}:${o.name}`), Promise.resolve()) }) }),
    };
    const yaml = "start: /\nsteps:\n  - click: { any: ['#one', 'text=Two'] }\n  - click: { role: radio, name: One }\n";
    await play(page, yaml, {
      beginStep: () => {
        const record = {};
        records.push(record);
        return record;
      },
    });
    expect(clicked).toEqual(['text=Two', 'radio:One']);
    expect(records.map((r) => r.locator)).toEqual([undefined, 1, undefined]);
  });

  test('a locator timeout lists the controls, and not during a handoff', async () => {
    const timeout = Object.assign(new Error('locator.click: Timeout 10ms exceeded.\nCall log: ...'), { name: 'TimeoutError' });
    const page = {
      goto: () => Promise.resolve(),
      getByRole: () => ({ first: () => ({ click: () => Promise.reject(timeout) }) }),
      locator: () => ({ ariaSnapshot: () => Promise.resolve('- button "White (01)"\n- button "Black (02)"') }),
    };
    const yaml = 'start: /\nsteps:\n  - click: { role: radio, name: "White (01)" }\n';
    const failure = await play(page, yaml).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(failure).toBe('step "click-1": locator.click: Timeout 10ms exceeded. Controls on the page: button "White (01)", button "Black (02)".');
    const inHandoff = await play(page, yaml, { handoff: { state: () => ({ waiting: true, text: '' }) } }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(inHandoff).toBe('step "click-1": locator.click: Timeout 10ms exceeded.');
  });
});
