import type { Identity, Step as StepRecord } from '@tagreeve/core';
import type { Page } from 'playwright';
import { describe, expect, test } from 'vitest';
import { providerBlockedOnSite, runPayment } from './payment.ts';

const CARD = '4242424242424242';
const identity = { firstName: 'Pw', lastName: 'Tester' } as Identity;

interface Setup {
  url?: string;
  /** Where the marker is: inside the card container, only elsewhere on the page, or nowhere. */
  marker?: 'inside' | 'outside' | 'none';
  frameUrl?: string | null;
  failFill?: boolean;
  failFillAt?: number;
  provider?: string;
}

function fake(setup: Setup = {}) {
  const log: string[] = [];
  const { url = 'http://localhost:3000/checkout/test-payment', marker = 'inside', frameUrl = 'http://127.0.0.1:4000/card-frame', failFill = false, failFillAt = 0 } = setup;
  let fills = 0;
  const container = {
    asElement: () => ({
      waitForSelector: async () => {
        log.push('marker');
        if (marker !== 'inside') throw new Error('timeout');
      },
    }),
  };
  const page = {
    url: () => url,
    locator: () => ({
      first: () => ({
        elementHandle: async () => ({
          contentFrame: async () => (frameUrl === null ? null : { url: () => frameUrl }),
          evaluateHandle: async () => container,
        }),
      }),
    }),
    frameLocator: (frame: string) => ({
      locator: (input: string) => ({
        fill: async (value: string) => {
          log.push(`fill ${frame} ${input} ${value}`);
          if (failFill && fills++ === failFillAt) throw new Error(`locator.fill: Timeout. fill("${value}")`);
        },
      }),
    }),
  } as unknown as Page;
  const recorder = { holdRedaction: () => void log.push('hold') };
  return { page, recorder, log };
}

type Allowed = { host: string; declaredProviders?: readonly string[] };

async function play(setup: Setup = {}, allowed: Allowed | null = { host: 'localhost' }, siteHost = 'localhost') {
  const { page, recorder, log } = fake(setup);
  const record = {} as StepRecord;
  const provider = setup.provider ?? 'fixture';
  const card = provider === 'shopify-bogus' ? '1' : CARD;
  const result = await runPayment(page, recorder, { provider, card }, identity, allowed ?? undefined, record, 2000, siteHost).then(
    () => undefined,
    (error: Error) => error,
  );
  return { error: result, log, record };
}

test('all gates pass: the redaction window opens first, then the provider values are typed', async () => {
  const { error, log, record } = await play();
  expect(error).toBeUndefined();
  expect(log).toEqual([
    'marker',
    'hold',
    `fill #card-frame #cc-number ${CARD}`,
    'fill #card-frame #cc-exp 12/40',
    'fill #card-frame #cc-csc 123',
  ]);
  expect(record.payment).toEqual({ provider: 'fixture', mode: 'test', testMode: 'marker' });
});

test.each([
  ['no allowed host', {}, null, 'localhost', 'test payments are not allowed in this run'],
  ['a page on another host', { url: 'http://example.com/pay' }, { host: 'localhost' }, 'localhost', 'test mode not detected'],
  ['an allowed host that is not the site host', {}, { host: 'localhost' }, '127.0.0.1', 'test mode not detected'],
  ['no test mode marker', { marker: 'none' }, { host: 'localhost' }, 'localhost', 'test mode not detected'],
  ['marker text outside the card container', { marker: 'outside' }, { host: 'localhost' }, 'localhost', 'test mode not detected'],
  ['a declaration for another provider and no marker', { marker: 'none' }, { host: 'localhost', declaredProviders: ['shopify-test'] }, 'localhost', 'test mode not detected'],
  ['a card frame from another host', { frameUrl: 'http://example.com/card-frame' }, { host: 'localhost' }, 'localhost', 'card frame not found'],
  ['a card frame that is not there', { frameUrl: null }, { host: 'localhost' }, 'localhost', 'card frame not found'],
  ['the fixture provider on a hosted site', { url: 'https://shop.example.com/pay' }, { host: 'shop.example.com' }, 'shop.example.com', 'only for loopback sites'],
] as const)('%s: the step fails and nothing is typed or held', async (_name, setup, allowed, siteHost, message) => {
  const { error, log, record } = await play(setup as Setup, allowed, siteHost);
  expect(error?.message).toContain(message);
  expect(log.filter((l) => l.startsWith('fill') || l === 'hold')).toEqual([]);
  expect(record.payment).toBeUndefined();
});

test('a declared provider skips the page marker and is recorded as declared', async () => {
  const { error, log, record } = await play({ marker: 'none' }, { host: 'localhost', declaredProviders: ['fixture'] });
  expect(error).toBeUndefined();
  expect(log).not.toContain('marker');
  expect(log.filter((l) => l.startsWith('fill'))).toHaveLength(3);
  expect(record.payment).toEqual({ provider: 'fixture', mode: 'test', testMode: 'declared' });
});

test('a declaration does not widen the host, the site or the card frame checks', async () => {
  const declared = { host: 'localhost', declaredProviders: ['fixture'] };
  for (const [setup, siteHost] of [
    [{ url: 'http://example.com/pay' }, 'localhost'],
    [{}, '127.0.0.1'],
    [{ frameUrl: 'http://example.com/card-frame' }, 'localhost'],
  ] as const) {
    const { error, log } = await play({ ...setup, marker: 'none' }, declared, siteHost);
    expect(error).toBeDefined();
    expect(log).toEqual([]);
  }
});

test('the first fill failing leaves payment unset', async () => {
  const { error, record } = await play({ failFill: true });
  expect(error?.message).toBe('card field number could not be filled');
  expect(record.payment).toBeUndefined();
});

test('a later fill failing keeps payment set and names the field', async () => {
  const { error, record } = await play({ failFill: true, failFillAt: 1 });
  expect(error?.message).toBe('card field expiry could not be filled');
  expect(record.payment).toMatchObject({ provider: 'fixture' });
});

describe.each(['shopify-test', 'shopify-bogus'])('%s runtime', (provider) => {
  const shop = { host: 'shop.example.com', declaredProviders: [provider] };

  test('types number, expiry, security code, then the name, each into its own frame', async () => {
    const { error, log } = await play({ provider, url: 'https://shop.example.com/checkout', frameUrl: 'https://checkout.pci.shopifyinc.com/frame' }, shop, 'shop.example.com');
    expect(error).toBeUndefined();
    const fills = log.filter((l) => l.startsWith('fill'));
    expect(fills.map((l) => /Card number|Expiration|Security code|Name on card/.exec(l)?.[0])).toEqual(['Card number', 'Expiration', 'Security code', 'Name on card']);
    expect(fills[3]).toContain('Pw Tester');
  });

  test('types nothing when the card frames come from another host', async () => {
    const { error, log } = await play({ provider, url: 'https://shop.example.com/checkout', frameUrl: 'https://evil.example.com/frame' }, shop, 'shop.example.com');
    expect(error?.message).toContain('card frame not found');
    expect(log).toEqual([]);
  });

  test('a name fill failure names the field', async () => {
    const { error } = await play({ provider, url: 'https://shop.example.com/checkout', frameUrl: 'https://checkout.pci.shopifyinc.com/frame', failFill: true, failFillAt: 3 }, shop, 'shop.example.com');
    expect(error?.message).toBe('card field name could not be filled');
  });
});

test('a failing fill names the field and not the value', async () => {
  const { error } = await play({ failFill: true });
  expect(error?.message).toBe('card field number could not be filled');
});

test('the loopback-only rule looks at the real site host', () => {
  expect(providerBlockedOnSite('fixture', 'localhost')).toBeUndefined();
  expect(providerBlockedOnSite('fixture', '[::1]')).toBeUndefined();
  expect(providerBlockedOnSite('fixture', 'shop.example.com')).toContain('only for loopback');
  expect(providerBlockedOnSite('shopify-bogus', 'shop.example.com')).toBeUndefined();
  expect(providerBlockedOnSite('nope', 'localhost')).toContain('unknown');
});

test('a value outside the provider table is refused', async () => {
  const { page, recorder, log } = fake();
  await expect(
    runPayment(page, recorder, { provider: 'fixture', card: '4000000000000002' }, identity, { host: 'localhost' }, {} as StepRecord, 2000, 'localhost'),
  ).rejects.toThrow('not a documented test payment');
  expect(log).toEqual([]);
});
