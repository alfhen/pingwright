import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Page } from 'playwright';
import { launchRecorder, playScenario, recordScenario, StepError, type Recorder } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'steps-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const CHECKOUT = `
start: /products/fake-tee
options: { seed: 12 }
steps:
  - click: "#pw-accept"
    label: accept
  - addToCart: "#add-to-cart"
  - visit: /checkout
  - fill:
      "#email": email
      "#first-name": firstName
      "#last-name": lastName
      "#phone": phone
      "#address1": address1
      "#city": city
      "#zip": zip
      "#country": SE
  - evaluate: "if (document.getElementById('country').value !== 'SE') throw new Error('country not set')"
  - click: "#continue"
  - fill:
      "#card-number": "4242424242424242"
      "#card-expiry": "12/34"
      "#card-cvc": "123"
  - click: "#pay"
    label: pay
  - wait: 7s
    label: settle
  - checkpoint: end
`;

describe('full fixture checkout', () => {
  test('plays every step, records Step records and attributes hits to steps', async () => {
    const parsed = parseScenario(CHECKOUT);
    const { records } = await recordScenario({ networkMode: 'stub', outDir, site: site.url, scenario: 'checkout', parsed });

    expect(records.steps.map((s) => s.index)).toEqual([...records.steps.keys()]);
    expect(records.steps.map((s) => s.label)).toEqual([
      'start', 'accept', 'addToCart-2', 'visit-3', 'fill-4', 'evaluate-5', 'click-6', 'fill-7', 'pay', 'settle', 'end',
    ]);
    for (const step of records.steps) {
      expect(step.error).toBeUndefined();
      expect(step.endedAt).not.toBeNull();
      expect(step.endedAt!).toBeGreaterThanOrEqual(step.startedAt);
    }
    expect(records.requests.every((r) => r.stepId !== null)).toBe(true);
    const stepIds = new Set(records.steps.map((s) => s.id));
    expect(records.requests.every((r) => stepIds.has(r.stepId!))).toBe(true);

    const settle = records.steps.find((s) => s.label === 'settle')!;
    const pay = records.steps.find((s) => s.label === 'pay')!;
    const purchase = records.hits.find((h) => h.vendor === 'ga4' && h.event === 'purchase' && h.page?.endsWith('/thank-you'));
    expect(purchase).toBeDefined();
    expect([pay.id, settle.id]).toContain(purchase!.stepId);
    const owner = records.steps.find((s) => purchase!.t >= s.startedAt && purchase!.t <= (s.endedAt ?? Infinity));
    expect(purchase!.stepId).toBe(owner?.id);
    expect(purchase!.stepId).toBe(records.requests.find((r) => r.id === purchase!.requestId)!.stepId);

    const accept = records.steps.find((s) => s.label === 'accept')!;
    const cartStep = records.steps.find((s) => s.label === 'addToCart-2')!;
    const addToCart = records.hits.find((h) => h.vendor === 'ga4' && h.event === 'add_to_cart');
    expect(addToCart).toBeDefined();
    const next = records.steps.find((s) => s.label === 'visit-3')!;
    expect([cartStep.id, next.id]).toContain(addToCart!.stepId);
    expect(records.dataLayerEvents.find((e) => e.event === 'add_to_cart')?.stepId).toBe(cartStep.id);
    expect(addToCart!.stepId).not.toBe(accept.id);
    expect(records.dataLayerEvents.some((e) => e.stepId === accept.id)).toBe(true);

    expect(records.run.identity).toMatchObject({ seed: 12, country: 'US' });
    expect(records.run.identitySeed).toBe(12);
  });

  test('checkpoints list cookies at the end of every step', async () => {
    const parsed = parseScenario(CHECKOUT);
    const { records } = await recordScenario({ networkMode: 'stub', outDir, site: site.url, scenario: 'checkout', parsed });
    expect(records.checkpoints.map((c) => c.label)).toEqual(records.steps.map((s) => s.label));
    const end = records.checkpoints.find((c) => c.label === 'end')!;
    expect(end.stepId).toBe(records.steps.find((s) => s.label === 'end')!.id);
    const consent = end.cookies.find((c) => c.name === 'pw_consent');
    expect(consent).toMatchObject({ domain: 'localhost', firstParty: true });
    expect(end.cookies.every((c) => c.expires === null || c.expires > 1e12)).toBe(true);
    const step = records.steps.find((s) => s.label === 'end')!;
    expect(end.t).toBeGreaterThanOrEqual(step.startedAt);
    expect(end.t).toBeLessThanOrEqual(step.endedAt!);
    const start = records.checkpoints.find((c) => c.label === 'start')!;
    expect(start.cookies.find((c) => c.name === 'pw_consent')).toBeUndefined();
  });
});

test('a failing consent handler fails the step and the run is still written', async () => {
  const parsed = parseScenario('start: /\nsteps:\n  - consent: accept\n');
  const consent = () => Promise.reject(new Error('handler failed'));
  const error = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed, consent }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StepError);
  expect((error as StepError).message).toContain('handler failed');
  const failed = (error as StepError).run!.records.steps.find((s) => s.label === 'consent-1');
  expect(failed?.error).toBe('handler failed');
});

test('handoff prints the reminder and waits for the resolver', async () => {
  const parsed = parseScenario('start: /\nsteps:\n  - handoff: Pay with the test card\n  - checkpoint: after\n');
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  const printed: string[] = [];
  let resolve!: () => void;
  const released = new Promise<void>((r) => (resolve = r));
  let reached = false;
  const play = playScenario(recorder, parsed, {
    print: (text) => printed.push(text),
    handoffResolver: async () => {
      reached = true;
      await released;
    },
  });
  await expect.poll(() => reached, { timeout: 20_000 }).toBe(true);
  expect(printed.join('')).toContain('Pay with the test card');
  expect(printed.join('')).toContain('test cards');
  resolve();
  await play;
  const { records } = await recorder.close();
  expect(records.steps.map((s) => s.label)).toEqual(['start', 'handoff-1', 'after']);
});

describe('payment and log-in guard', () => {
  const PAGE = `<!doctype html><title>Pay</title>
<input id="name" autocomplete="name"><input id="cc" autocomplete="cc-number">
<input id="secret" type="password"><input id="holder" name="cardholder">
<label for="cc" id="cc-label">Card number</label>
<label id="pwl">Password <input type="password" autocomplete="off"></label>`;

  async function play(yaml: string, host: string) {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: `https://${host}` });
    await recorder.context.route(`https://${host}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    try {
      const error = await playScenario(recorder, parseScenario(yaml)).then(() => undefined, (e: unknown) => e);
      const card = await recorder.context.pages()[0]!.locator('#cc').inputValue();
      return { error, card };
    } finally {
      await recorder.close();
    }
  }

  test('filling a card field on a non-loopback host fails the step', async () => {
    const { error, card } = await play('start: /\nsteps:\n  - fill: { "#name": firstName }\n  - fill: { "#cc": "4242424242424242" }\n', 'shop.example.com');
    expect(card).toBe('');
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toMatch(/payments and log-ins must be handoff steps/i);
    expect((error as StepError).label).toBe('fill-2');
  });

  test.each(['#secret', '#holder'])('filling %s on a non-loopback host fails the step', async (selector) => {
    const { error } = await play(`start: /\nsteps:\n  - fill: { "${selector}": x }\n`, 'shop.example.com');
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toMatch(/payments and log-ins must be handoff steps/i);
  });

  test('an evaluate step cannot set a card or password field on a non-loopback host', async () => {
    const script = "document.getElementById('cc').value = '4242424242424242'";
    const { error, card } = await play(`start: /\nsteps:\n  - evaluate: "${script}"\n`, 'shop.example.com');
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toMatch(/payments and log-ins must be handoff steps/i);
    expect(card).toBe('');
  });

  test.each([
    "const c = document.getElementById('cc'); c.setAttributeNS(null, 'value', '4242424242424242'); fetch('/pay', { method: 'POST', body: c.value })",
    "const c = document.getElementById('cc'); const a = document.createAttribute('value'); c.setAttributeNode(a); a.value = '4242424242424242'; fetch('/pay', { method: 'POST', body: c.value })",
  ])('an evaluate step cannot send a card number set through attribute APIs %#', async (script) => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    const error = await playScenario(recorder, parseScenario(`start: /\nsteps:\n  - evaluate: ${JSON.stringify(script)}\n`)).then(() => undefined, (e: unknown) => e);
    const { records } = await recorder.close();
    expect(error).toBeInstanceOf(StepError);
    expect(JSON.stringify(records.requests)).not.toContain('4242424242424242');
  });

  test('an evaluate step cannot send a card number it just set', async () => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    const script = "const c = document.getElementById('cc'); c.value = '4242424242424242'; fetch('/pay', { method: 'POST', body: c.value })";
    const error = await playScenario(recorder, parseScenario(`start: /\nsteps:\n  - evaluate: "${script}"\n`)).then(() => undefined, (e: unknown) => e);
    const { records } = await recorder.close();
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toMatch(/payments and log-ins must be handoff steps/i);
    expect(JSON.stringify(records.requests)).not.toContain('4242424242424242');
  });

  test('an evaluate step that removes another field does not fail on a card field that already held a value', async () => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    const html = '<!doctype html><input id="n"><input id="cc" autocomplete="cc-number" value="prefilled">';
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    try {
      const error = await playScenario(recorder, parseScenario(`start: /\nsteps:\n  - evaluate: "document.getElementById('n').remove()"\n`)).then(() => undefined, (e: unknown) => e);
      expect(error).toBeUndefined();
      expect(await recorder.context.pages()[0]!.locator('#cc').inputValue()).toBe('prefilled');
    } finally {
      await recorder.close();
    }
  });

  test.each([
    "document.getElementById('cc').outerHTML = '<input id=cc autocomplete=cc-number value=4242424242424242>'",
    "document.getElementById('cc').insertAdjacentHTML('afterend', '<input autocomplete=cc-number value=4242424242424242>')",
  ])('an evaluate step cannot leave a card number through HTML parsing %#', async (script) => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
    try {
      const error = await playScenario(recorder, parseScenario(`start: /\nsteps:\n  - evaluate: ${JSON.stringify(script)}\n`)).then(() => undefined, (e: unknown) => e);
      expect(error).toBeInstanceOf(StepError);
      const values = await recorder.context.pages()[0]!.locator('[autocomplete=cc-number]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
      expect(values.join('')).not.toContain('4242');
    } finally {
      await recorder.close();
    }
  });

  test('an evaluate step may set an ordinary field', async () => {
    const { error } = await play(`start: /\nsteps:\n  - evaluate: "document.getElementById('name').value = 'x'"\n`, 'shop.example.com');
    expect(error).toBeUndefined();
  });

  test.each(['label[for=cc]', '#pwl', 'text=Card number'])('filling through the label %s fails the step', async (selector) => {
    const { error, card } = await play(`start: /\nsteps:\n  - fill: { "${selector}": x }\n`, 'shop.example.com');
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toMatch(/payments and log-ins must be handoff steps/i);
    expect(card).toBe('');
  });

  test('filling a select through its label picks the option', async () => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    const html = '<!doctype html><label for="c" id="cl">Country</label><select id="c"><option value="US">US</option><option value="SE">SE</option></select>';
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    try {
      await playScenario(recorder, parseScenario('start: /\nsteps:\n  - fill: { "#cl": SE }\n'));
      expect(await recorder.context.pages()[0]!.locator('#c').inputValue()).toBe('SE');
    } finally {
      await recorder.close();
    }
  });

  test.each(['#cl', 'label[for=c]'])('a select step through the label %s picks the option', async (selector) => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    const html = '<!doctype html><label for="c" id="cl">Country</label><select id="c"><option value="US">US</option><option value="SE">Sweden</option></select>';
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    try {
      await playScenario(recorder, parseScenario(`start: /\nsteps:\n  - select: { "${selector}": Sweden }\n`));
      expect(await recorder.context.pages()[0]!.locator('#c').inputValue()).toBe('SE');
    } finally {
      await recorder.close();
    }
  });

  test('a select step on the label of a text input fails with "is not a select"', async () => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: 'https://shop.example.com' });
    const html = '<!doctype html><label for="t" id="tl">Name</label><input id="t">';
    await recorder.context.route('https://shop.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    try {
      const error = await playScenario(recorder, parseScenario('start: /\nsteps:\n  - select: { "#tl": x }\n')).then(() => undefined, (e: unknown) => e);
      expect((error as Error).message).toContain('is not a select');
    } finally {
      await recorder.close();
    }
  });

  test('an ordinary field on a non-loopback host is filled', async () => {
    expect((await play('start: /\nsteps:\n  - fill: { "#name": firstName }\n', 'shop.example.com')).error).toBeUndefined();
  });
});

describe('addToCart', () => {
  test('fails when the click adds nothing to the cart', async () => {
    const parsed = parseScenario('start: /products/fake-tee\nsteps:\n  - addToCart: "#pw-accept"\n');
    const error = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed, cartTimeoutMs: 500 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toContain('click did not add to cart');
  });

  const SHOP = 'https://shop.example.com';
  const shopPage = (button: string) => `<!doctype html><title>Shop</title>${button}`;

  async function addToCartError(
    button: string,
    cart: { path: string; status: number; location?: string; delayMs?: number },
    yaml = 'start: /\nsteps:\n  - addToCart: "#add"\n',
  ): Promise<unknown> {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: SHOP });
    await recorder.context.route(`${SHOP}/**`, async (route) => {
      if (new URL(route.request().url()).pathname === cart.path) {
        if (cart.delayMs) await new Promise((resolve) => setTimeout(resolve, cart.delayMs));
        await route.fulfill({
          status: cart.status,
          contentType: 'application/json',
          body: '{}',
          ...(cart.location ? { headers: { location: cart.location } } : {}),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'text/html', body: shopPage(button) });
      }
    });
    const error = await playScenario(recorder, parseScenario(yaml), { cartTimeoutMs: 1500 }).then(
      () => undefined,
      (e: unknown) => e,
    );
    await recorder.close();
    return error;
  }

  const fetchButton = (path: string) => `<button id="add" onclick="fetch('${path}', { method: 'POST' })">Add</button>`;

  test('fails when the cart request is answered with a 422 after a delay', async () => {
    const error = await addToCartError(fetchButton('/cart/add.js'), { path: '/cart/add.js', status: 422, delayMs: 400 });
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toContain('click did not add to cart');
  });

  test('passes when the cart request is answered with a 200 after a delay', async () => {
    const error = await addToCartError(fetchButton('/cart/add.js'), { path: '/cart/add.js', status: 200, delayMs: 400 });
    expect(error).toBeUndefined();
  });

  test('passes when a cart form POST is answered with a 302', async () => {
    const form = '<form method="post" action="/cart/add"><button id="add">Add</button></form>';
    const error = await addToCartError(form, { path: '/cart/add', status: 302, location: `${SHOP}/cart/done` });
    expect(error).toBeUndefined();
  });

  test('a POST to a custom basket path fails without cartRequest and passes with it', async () => {
    const button = fetchButton('/api/basket/items');
    const cart = { path: '/api/basket/items', status: 200 };
    const failed = await addToCartError(button, cart);
    expect(failed).toBeInstanceOf(StepError);
    expect((failed as StepError).message).toContain('click did not add to cart');
    const passed = await addToCartError(button, cart, "start: /\noptions: { cartRequest: '/api/basket/' }\nsteps:\n  - addToCart: \"#add\"\n");
    expect(passed).toBeUndefined();
  });

  test('passes with a custom cart check', async () => {
    const parsed = parseScenario('start: /products/fake-tee\nsteps:\n  - addToCart: "#pw-accept"\n');
    const cartCheck = ({ dataLayerEvents }: { dataLayerEvents: { isConsentCommand: boolean }[] }) => dataLayerEvents.some((e) => e.isConsentCommand);
    await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed, cartCheck });
  });
});

describe('consent: withdraw', () => {
  const ACCEPT = 'start: /\noptions: { consentTimeout: 1s }\nsteps:\n  - consent: accept\n  - wait: 500ms\n';

  test('fails with a hint when the banner was not reopened', async () => {
    const parsed = parseScenario(`${ACCEPT}  - consent: withdraw\n`);
    const error = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StepError);
    expect((error as StepError).message).toContain('banner not shown (withdraw needs the banner reopened first)');
  });

  test('rejects after the cookie settings link reopened the banner', async () => {
    const parsed = parseScenario(`${ACCEPT}  - click: "#pw-cookie-settings"\n  - consent: withdraw\n  - wait: 1s\n`);
    const { records } = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed });
    expect(records.consentEpochs.map((e) => e.label)).toEqual(['undecided', 'granted', 'withdrawn']);
  });
});

describe('handoff', () => {
  test('requests sent during a handoff do not keep typed values, and the record says so', async () => {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
    const parsed = parseScenario('start: /\nsteps:\n  - handoff: Log in\n  - checkpoint: after\n');
    const send = (tag: string) =>
      recorder.context.pages()[0]!.evaluate(async (t) => {
        await fetch(`/login?user=${t}&pass=${t}`, { method: 'POST', body: `password=secret-${t}` }).catch(() => undefined);
      }, tag);
    await playScenario(recorder, parsed, {
      print: () => undefined,
      handoffResolver: async () => {
        await send('during');
      },
    });
    await send('after');
    const { records } = await recorder.close();
    const during = records.requests.find((r) => r.url.includes('/login') && r.redacted === 'handoff')!;
    expect(during.postData).toBe('[redacted]');
    expect(during.url).not.toContain('during');
    expect(during.url).toContain('user=');
    const after = records.requests.find((r) => r.url.includes('/login') && r.url.includes('after'))!;
    expect(after.redacted).toBeUndefined();
    expect(after.postData).toContain('secret-after');
    expect(JSON.stringify(records.requests)).not.toContain('secret-during');
  });
});

describe('handoff redaction', () => {
  async function playHandoff(inHandoff: (recorder: Recorder) => Promise<void>, afterHandoff?: (recorder: Recorder) => Promise<void>) {
    const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
    const parsed = parseScenario('start: /\nsteps:\n  - handoff: Log in\n  - checkpoint: after\n');
    await playScenario(recorder, parsed, { print: () => undefined, handoffResolver: () => inHandoff(recorder) });
    await afterHandoff?.(recorder);
    return (await recorder.close()).records;
  }

  test('a GET form submitted during a handoff leaves no typed value in the url, frameUrl or referer', async () => {
    const records = await playHandoff(async (recorder) => {
      const page = recorder.context.pages()[0]!;
      await page.evaluate(() => (location.href = '/?user=alice&pass=secret-get'));
      await page.waitForURL(/secret-get/);
      await page.evaluate(() => fetch('/api/after-nav').catch(() => undefined));
    });
    const redacted = records.requests.filter((r) => r.redacted === 'handoff');
    expect(redacted.find((r) => r.url.includes('/api/after-nav'))).toBeDefined();
    expect(redacted.find((r) => r.resourceType === 'document' && r.url.includes('user='))).toBeDefined();
    expect(JSON.stringify(redacted)).not.toContain('secret-get');
  });

  test('a send queued during a handoff and flushed after it is redacted, one queued after it is not', async () => {
    const queue = (page: Page, tag: string) =>
      page.evaluate((t) => {
        const entry = { key: `key-${t}`, method: 'POST', url: `${location.origin}/api/${t}`, resourceType: 'ping', postData: `password=secret-${t}`, headers: {}, frameUrl: location.href, queuedAt: Date.now() };
        sessionStorage.setItem('__pingwrightUnloadQueue', JSON.stringify([...JSON.parse(sessionStorage.getItem('__pingwrightUnloadQueue') ?? '[]'), entry]));
      }, tag);
    const records = await playHandoff(
      (recorder) => queue(recorder.context.pages()[0]!, 'during'),
      async (recorder) => {
        await recorder.wait(50);
        await queue(recorder.context.pages()[0]!, 'later');
      },
    );
    const during = records.requests.find((r) => r.url.endsWith('/api/during'))!;
    expect(during.initiator).toBe('unload');
    expect(during.redacted).toBe('handoff');
    expect(during.postData).toBe('[redacted]');
    const later = records.requests.find((r) => r.url.endsWith('/api/later'))!;
    expect(later.redacted).toBeUndefined();
    expect(later.postData).toBe('password=secret-later');
  });

  test('a GA4 hit sent during a handoff keeps its query and is decoded', async () => {
    const hit = 'https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1.1&en=page_view&dl=https%3A%2F%2Fexample.com%2F';
    const records = await playHandoff(async (recorder) => {
      await recorder.context.pages()[0]!.evaluate((u) => fetch(u, { method: 'POST', mode: 'no-cors', body: 'en=page_view' }).catch(() => undefined), hit);
    });
    const request = records.requests.find((r) => r.url.includes('/g/collect'))!;
    expect(request.redacted).toBeUndefined();
    expect(request.url).toContain('tid=G-PWTEST0001');
    expect(records.hits.some((h) => h.vendor === 'ga4' && h.requestId === request.id)).toBe(true);
  });
});

test('a send queued while the page unloads during a handoff does not keep typed values', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  const parsed = parseScenario('start: /\nsteps:\n  - handoff: Log in\n  - checkpoint: after\n');
  await playScenario(recorder, parsed, {
    print: () => undefined,
    handoffResolver: async () => {
      const page = recorder.context.pages()[0]!;
      await page
        .evaluate(() => {
          addEventListener('pagehide', () => navigator.sendBeacon('/api/form', 'password=secret-during'));
          location.href = '/?done';
        })
        .catch(() => undefined);
      await page.waitForURL(/done/);
    },
  });
  const { records } = await recorder.close();
  const beacon = records.requests.find((r) => r.url.endsWith('/api/form'))!;
  expect(beacon.initiator).toBe('unload');
  expect(beacon.postData).toBe('[redacted]');
  expect(beacon.redacted).toBe('handoff');
});

test('a failed request records why it failed', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  await recorder.context.route('**/blocked.js', (route) => route.abort('connectionrefused'));
  const page = await recorder.visit(site.url);
  await page.evaluate(() => fetch('/blocked.js').catch(() => undefined));
  const { records } = await recorder.close();
  const failed = records.requests.find((r) => r.url.endsWith('/blocked.js'))!;
  expect(failed.outcome).toBe('failed');
  expect(failed.failure).toBe('net::ERR_CONNECTION_REFUSED');
});
