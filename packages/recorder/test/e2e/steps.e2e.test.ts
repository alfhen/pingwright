import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { launchRecorder, playScenario, recordScenario, StepError } from '../../src/index.ts';

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
    const addToCart = records.hits.find((h) => h.vendor === 'ga4' && h.event === 'add_to_cart');
    expect(addToCart?.stepId).not.toBe(accept.id);
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
    const start = records.checkpoints.find((c) => c.label === 'start')!;
    expect(start.cookies.find((c) => c.name === 'pw_consent')).toBeUndefined();
  });
});

test('the default consent handler fails the step and the run is still written', async () => {
  const parsed = parseScenario('start: /\nsteps:\n  - consent: accept\n');
  const error = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(StepError);
  expect((error as StepError).message).toContain('consent step not wired');
  const failed = (error as StepError).run!.records.steps.find((s) => s.label === 'consent-1');
  expect(failed?.error).toBe('consent step not wired');
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
<input id="secret" type="password"><input id="holder" name="cardholder">`;

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
  });

  test('an ordinary field on a non-loopback host is filled', async () => {
    expect((await play('start: /\nsteps:\n  - fill: { "#name": firstName }\n', 'shop.example.com')).error).toBeUndefined();
  });
});
