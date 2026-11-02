import type { Identity, Step as StepRecord } from '@tagreeve/core';
import type { Page } from 'playwright';
import { expect, test } from 'vitest';
import { providerBlockedOnSite, runPayment } from './payment.ts';

const CARD = '4242424242424242';
const identity = { firstName: 'Pw', lastName: 'Tester' } as Identity;

interface Setup {
  url?: string;
  marker?: boolean;
  frameUrl?: string | null;
  failFill?: boolean;
}

function fake(setup: Setup = {}) {
  const log: string[] = [];
  const { url = 'http://localhost:3000/checkout/test-payment', marker = true, frameUrl = 'http://127.0.0.1:4000/card-frame', failFill = false } = setup;
  const page = {
    url: () => url,
    locator: (selector: string) => ({
      first: () => ({
        waitFor: async () => {
          if (selector === '#pw-test-mode' && !marker) throw new Error('timeout');
        },
        elementHandle: async () => ({ contentFrame: async () => (frameUrl === null ? null : { url: () => frameUrl }) }),
      }),
    }),
    frameLocator: (frame: string) => ({
      locator: (input: string) => ({
        fill: async (value: string) => {
          log.push(`fill ${frame} ${input} ${value}`);
          if (failFill) throw new Error(`locator.fill: Timeout. fill("${value}")`);
        },
      }),
    }),
  } as unknown as Page;
  const recorder = { holdRedaction: () => void log.push('hold') };
  return { page, recorder, log };
}

async function play(setup: Setup = {}, allowed: { host: string } | null = { host: 'localhost' }, siteHost = 'localhost') {
  const { page, recorder, log } = fake(setup);
  const record = {} as StepRecord;
  const result = await runPayment(page, recorder, { provider: 'fixture', card: CARD }, identity, allowed ?? undefined, record, 2000, siteHost).then(
    () => undefined,
    (error: Error) => error,
  );
  return { error: result, log, record };
}

test('all gates pass: the redaction window opens first, then the provider values are typed', async () => {
  const { error, log, record } = await play();
  expect(error).toBeUndefined();
  expect(log).toEqual([
    'hold',
    `fill #card-frame #cc-number ${CARD}`,
    'fill #card-frame #cc-exp 12/40',
    'fill #card-frame #cc-csc 123',
  ]);
  expect(record.payment).toEqual({ provider: 'fixture', mode: 'test' });
});

test.each([
  ['no allowed host', {}, null, 'localhost', 'test payments are not allowed in this run'],
  ['a page on another host', { url: 'http://example.com/pay' }, { host: 'localhost' }, 'localhost', 'test mode not detected'],
  ['an allowed host that is not the site host', {}, { host: 'localhost' }, '127.0.0.1', 'test mode not detected'],
  ['no test mode marker', { marker: false }, { host: 'localhost' }, 'localhost', 'test mode not detected'],
  ['a card frame from another host', { frameUrl: 'http://example.com/card-frame' }, { host: 'localhost' }, 'localhost', 'card frame not found'],
  ['a card frame that is not there', { frameUrl: null }, { host: 'localhost' }, 'localhost', 'card frame not found'],
  ['the fixture provider on a hosted site', { url: 'https://shop.example.com/pay' }, { host: 'shop.example.com' }, 'shop.example.com', 'only for loopback sites'],
] as const)('%s: the step fails and nothing is typed or held', async (_name, setup, allowed, siteHost, message) => {
  const { error, log, record } = await play(setup as Setup, allowed, siteHost);
  expect(error?.message).toContain(message);
  expect(log).toEqual([]);
  expect(record.payment).toBeUndefined();
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
