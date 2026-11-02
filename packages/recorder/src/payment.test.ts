import type { Identity, Step as StepRecord } from '@tagreeve/core';
import type { Page } from 'playwright';
import { describe, expect, test } from 'vitest';
import { providerBlockedOnSite, runPayment } from './payment.ts';

const CARD = '4242424242424242';
const identity = { firstName: 'Pw', lastName: 'Tester' } as Identity;
const FIXTURE_FRAME = '#card-frame, #card-frame-number';
const FIXTURE_FRAMES = [FIXTURE_FRAME, '#card-frame, #card-frame-exp', '#card-frame, #card-frame-csc'];
const SHOPIFY_FRAMES = ['iframe[title*="Card number" i]', 'iframe[title*="Expiration" i]', 'iframe[title*="Security code" i]', 'iframe[title*="Name on card" i]'];

interface FakeFrame {
  name?: string;
  visible?: boolean;
  /** null: the iframe has no content frame. */
  url?: string | null;
  /** Selector parts (split on commas) this element answers to. Default: every selector. */
  matches?: string[];
}

interface Setup {
  url?: string;
  /** Where the marker is: inside the card container, only elsewhere on the page, or nowhere. */
  marker?: 'inside' | 'outside' | 'none';
  frameUrl?: string | null;
  frames?: FakeFrame[];
  /** The visible-input count each call to count() returns; the last value repeats. */
  counts?: number[];
  /** The frames move to this URL once the first count() has been answered. */
  moveFramesAfterCount?: string;
  failFill?: boolean;
  failFillAt?: number;
  fillMessage?: (value: string) => string;
  provider?: string;
  timeout?: number;
}

const GOOD_FRAME = 'http://127.0.0.1:4000/card-frame';

function fake(setup: Setup = {}) {
  const log: string[] = [];
  const { url = 'http://localhost:3000/checkout/test-payment', marker = 'inside', frameUrl = GOOD_FRAME, failFill = false, failFillAt = 0, counts = [1] } = setup;
  const frames = (setup.frames ?? [{ url: frameUrl }]).map((f, i) => ({ name: `f${i}`, visible: true, url: GOOD_FRAME, ...f }));
  let fills = 0;
  let countCalls = 0;
  const container = {
    asElement: () => ({
      waitForSelector: async () => {
        log.push('marker');
        if (marker !== 'inside') throw new Error('timeout');
      },
    }),
  };
  const element = (frame: (typeof frames)[number], selector: string) => ({
    isVisible: async () => frame.visible,
    evaluateHandle: async () => container,
    contentFrame: async () =>
      frame.url === null
        ? null
        : {
            url: () => frame.url as string,
            locator: (input: string) => ({
              filter: () => ({
                count: async () => {
                  const count = counts[Math.min(countCalls++, counts.length - 1)]!;
                  if (setup.moveFramesAfterCount) for (const f of frames) f.url = setup.moveFramesAfterCount;
                  return count;
                },
                fill: async (value: string) => {
                  log.push(`fill ${selector} ${input} ${value} @${frame.name}`);
                  if (failFill && fills++ === failFillAt) throw new Error(setup.fillMessage?.(value) ?? `locator.fill: Timeout. fill("${value}")`);
                },
              }),
            }),
          },
  });
  const page = {
    url: () => {
      log.push('url');
      return url;
    },
    locator: (selector: string) => {
      log.push(`locator ${selector}`);
      const parts = selector.split(',').map((s) => s.trim());
      return { elementHandles: async () => frames.filter((f) => !f.matches || f.matches.some((m) => parts.includes(m))).map((f) => element(f, selector)) };
    },
  } as unknown as Page;
  const recorder = { holdRedaction: () => void log.push('hold') };
  return { page, recorder, log, frames };
}

type Allowed = { host: string; declaredProviders?: readonly string[] };

async function play(setup: Setup = {}, allowed: Allowed | null = { host: 'localhost' }, siteHost = 'localhost') {
  const { page, recorder, log } = fake(setup);
  const record = {} as StepRecord;
  const provider = setup.provider ?? 'fixture';
  const card = provider === 'shopify-bogus' ? '1' : CARD;
  const result = await runPayment(page, recorder, { provider, card }, identity, allowed ?? undefined, record, setup.timeout ?? 2000, siteHost).then(
    () => undefined,
    (error: Error) => error,
  );
  return { error: result, log, record };
}

const fills = (log: string[]) => log.filter((l) => l.startsWith('fill'));

test('all gates pass: host check, frame lookup, marker, hold, then the provider values are typed', async () => {
  const { error, log, record } = await play();
  expect(error).toBeUndefined();
  expect(log).toEqual([
    'url',
    ...FIXTURE_FRAMES.map((s) => `locator ${s}`),
    'marker',
    'hold',
    `fill ${FIXTURE_FRAME} #cc-number ${CARD} @f0`,
    `fill ${FIXTURE_FRAMES[1]} #cc-exp 12/40 @f0`,
    `fill ${FIXTURE_FRAMES[2]} #cc-csc 123 @f0`,
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
  ['a card frame from another host', { frameUrl: 'http://example.com/card-frame', timeout: 300 }, { host: 'localhost' }, 'localhost', 'card frame not found (number): served from another host'],
  ['a card frame that is not there', { frameUrl: null, timeout: 300 }, { host: 'localhost' }, 'localhost', 'card frame not found (number): not found'],
  ['no card frame element', { frames: [], timeout: 300 }, { host: 'localhost' }, 'localhost', 'card frame not found (number): not found'],
  ['a card frame that is hidden', { frames: [{ visible: false }], timeout: 300 }, { host: 'localhost' }, 'localhost', 'card frame not found (number): not visible'],
  ['the fixture provider on a hosted site', { url: 'https://shop.example.com/pay' }, { host: 'shop.example.com' }, 'shop.example.com', 'only for loopback sites'],
] as const)('%s: the step fails and nothing is typed or held', async (_name, setup, allowed, siteHost, message) => {
  const { error, log, record } = await play(setup as Setup, allowed, siteHost);
  expect(error?.message).toContain(message);
  expect(log.filter((l) => l.startsWith('fill') || l === 'hold')).toEqual([]);
  expect(record.payment).toBeUndefined();
});

test('a card frame error never names the other host', async () => {
  const { error } = await play({ frameUrl: 'http://other-card-host.invalid/card-frame', timeout: 300 });
  expect(error?.message).toBe('card frame not found (number): served from another host');
});

test('a declared provider skips the page marker and is recorded as declared', async () => {
  const { error, log, record } = await play({ marker: 'none' }, { host: 'localhost', declaredProviders: ['fixture'] });
  expect(error).toBeUndefined();
  expect(log).not.toContain('marker');
  expect(fills(log)).toHaveLength(3);
  expect(record.payment).toEqual({ provider: 'fixture', mode: 'test', testMode: 'declared' });
});

test('a declaration does not widen the host, the site or the card frame checks', async () => {
  const declared = { host: 'localhost', declaredProviders: ['fixture'] };
  for (const [setup, siteHost] of [
    [{ url: 'http://example.com/pay' }, 'localhost'],
    [{}, '127.0.0.1'],
    [{ frameUrl: 'http://example.com/card-frame', timeout: 300 }, 'localhost'],
  ] as const) {
    const { error, log } = await play({ ...setup, marker: 'none' }, declared, siteHost);
    expect(error).toBeDefined();
    expect(fills(log)).toEqual([]);
    expect(log).not.toContain('hold');
  }
});

describe('duplicate frames and inputs', () => {
  const hiddenDuplicate = { name: 'hidden', visible: false };
  const real = { name: 'real' };

  test.each([
    ['duplicate first', [hiddenDuplicate, real]],
    ['duplicate second', [real, hiddenDuplicate]],
  ])('%s: the hidden duplicate is skipped and the visible frame gets every value', async (_name, frames) => {
    const setup = fake({ frames });
    expect(setup.frames.map((f) => f.visible)).toContain(false);
    expect(await setup.page.locator(FIXTURE_FRAME).elementHandles()).toHaveLength(2);
    const { error, log } = await play({ frames });
    expect(error).toBeUndefined();
    expect(fills(log)).toHaveLength(3);
    for (const line of fills(log)) expect(line).toMatch(/@real$/);
  });

  test('a duplicate served from another host is skipped too', async () => {
    const { error, log } = await play({ frames: [{ name: 'elsewhere', url: 'http://example.com/card-frame' }, real] });
    expect(error).toBeUndefined();
    for (const line of fills(log)) expect(line).toMatch(/@real$/);
  });

  test('an input count that goes from 0 to 1 is waited for and then typed', async () => {
    const { error, log } = await play({ counts: [0, 0, 1] });
    expect(error).toBeUndefined();
    expect(fills(log)).toHaveLength(3);
  });

  test('an input count that stays at 2 fails closed with the count and types nothing', async () => {
    const counts = [2];
    expect(counts).toContain(2);
    const { error, log, record } = await play({ counts, timeout: 300 });
    expect(error?.message).toBe('card field number could not be filled: 2 visible inputs match');
    expect(fills(log)).toEqual([]);
    expect(record.payment).toBeUndefined();
  });

  test('a frame that moves to another host after the count gets nothing typed', async () => {
    const { error, log, record } = await play({ moveFramesAfterCount: 'http://example.com/card-frame' });
    expect(error?.message).toBe('card field number could not be filled: the card frame is gone or not served from the card host');
    expect(fills(log)).toEqual([]);
    expect(record.payment).toBeUndefined();
  });
});

describe('split card frames', () => {
  const split = [
    { name: 'number', matches: ['#card-frame-number'] },
    { name: 'exp', matches: ['#card-frame-exp'] },
    { name: 'csc', matches: ['#card-frame-csc'] },
  ];

  test('each field is typed into its own frame', async () => {
    const { error, log } = await play({ frames: split });
    expect(error).toBeUndefined();
    expect(fills(log).map((l) => l.split('@')[1])).toEqual(['number', 'exp', 'csc']);
  });

  test('a missing frame for one field fails that field before anything is typed', async () => {
    const { error, log } = await play({ frames: split.slice(0, 2), timeout: 300 });
    expect(error?.message).toBe('card frame not found (cvc): not found');
    expect(fills(log)).toEqual([]);
    expect(log).not.toContain('hold');
  });
});

describe('the reason of a fill error', () => {
  test('the first line is kept and the field is named', async () => {
    const { error, record } = await play({ failFill: true });
    expect(error?.message).toBe('card field number could not be filled: locator.fill: Timeout. fill("[value]")');
    expect(record.payment).toBeUndefined();
  });

  test('a short test card does not eat digits of a longer number in the reason', async () => {
    const { error } = await play(
      { provider: 'shopify-bogus', url: 'https://shop.example.com/checkout', frameUrl: 'https://checkout.pci.shopifyinc.com/frame', failFill: true, fillMessage: (value) => `Timeout 15000ms exceeded fill("${value}")` },
      { host: 'shop.example.com', declaredProviders: ['shopify-bogus'] },
      'shop.example.com',
    );
    expect(error?.message).toBe('card field number could not be filled: Timeout 15000ms exceeded fill("[value]")');
  });

  test('the card number and the expiry are removed even next to another digit', async () => {
    const { error } = await play({ failFill: true, fillMessage: (value) => `Timeout fill("${value}1") at 12/401` });
    expect(error?.message).toContain('card field number could not be filled: ');
    expect(error?.message).not.toContain(CARD);
    expect(error?.message).not.toContain('12/40');
    expect(error?.message).toBe('card field number could not be filled: Timeout fill("[value]1") at [value]1');
  });

  test('a later fill failing keeps payment set and names the field', async () => {
    const { error, record } = await play({ failFill: true, failFillAt: 1 });
    expect(error?.message).toContain('card field expiry could not be filled: ');
    expect(record.payment).toMatchObject({ provider: 'fixture' });
  });

  test('typed values in the first line never reach the message', async () => {
    const message = () => `locator.fill("${CARD}") failed for 12/40 with 123 as Pw Tester, Pw and Tester\nsecond line`;
    expect(message()).toContain(CARD);
    const { error } = await play({ failFill: true, fillMessage: message });
    expect(error?.message).toContain('card field number could not be filled');
    for (const value of [CARD, '12/40', '123', 'Pw', 'Tester', 'second line']) expect(error?.message).not.toContain(value);
  });

  test('a name fill failure names the field', async () => {
    const { error } = await play(
      { provider: 'shopify-test', url: 'https://shop.example.com/checkout', frameUrl: 'https://checkout.pci.shopifyinc.com/frame', failFill: true, failFillAt: 3 },
      { host: 'shop.example.com', declaredProviders: ['shopify-test'] },
      'shop.example.com',
    );
    expect(error?.message).toContain('card field name could not be filled: ');
  });
});

describe.each(['shopify-test', 'shopify-bogus'])('%s runtime', (provider) => {
  const shop = { host: 'shop.example.com', declaredProviders: [provider] };
  const base = { provider, url: 'https://shop.example.com/checkout', frameUrl: 'https://checkout.pci.shopifyinc.com/frame' };

  test('looks up the four Shopify frame selectors, then types into each with the bare input selector', async () => {
    const { error, log } = await play(base, shop, 'shop.example.com');
    expect(error).toBeUndefined();
    expect(log.filter((l) => l.startsWith('locator'))).toEqual(SHOPIFY_FRAMES.map((s) => `locator ${s}`));
    const typed = fills(log);
    expect(typed.map((l) => /Card number|Expiration|Security code|Name on card/.exec(l)?.[0])).toEqual(['Card number', 'Expiration', 'Security code', 'Name on card']);
    for (const line of typed) expect(line).toMatch(/\] input /);
    expect(typed[3]).toContain('Pw Tester');
  });

  test('types nothing when the card frames come from another host', async () => {
    const { error, log } = await play({ ...base, frameUrl: 'https://evil.example.com/frame', timeout: 300 }, shop, 'shop.example.com');
    expect(error?.message).toContain('card frame not found');
    expect(log.filter((l) => l.startsWith('fill') || l === 'hold')).toEqual([]);
  });
});

describe('shopify-test in marker mode', () => {
  const base = { provider: 'shopify-test', url: 'https://shop.example.com/checkout', frameUrl: 'https://checkout.pci.shopifyinc.com/frame' };

  test('the marker is checked before the hold when the provider is not declared', async () => {
    const { error, log, record } = await play(base, { host: 'shop.example.com' }, 'shop.example.com');
    expect(error).toBeUndefined();
    expect(log.indexOf('marker')).toBeGreaterThan(log.lastIndexOf(`locator ${SHOPIFY_FRAMES[3]}`));
    expect(log.indexOf('hold')).toBeGreaterThan(log.indexOf('marker'));
    expect(log.indexOf('hold')).toBeLessThan(log.findIndex((l) => l.startsWith('fill')));
    expect(record.payment?.testMode).toBe('marker');
  });

  test('without the marker nothing is typed', async () => {
    const { error, log } = await play({ ...base, marker: 'none' }, { host: 'shop.example.com' }, 'shop.example.com');
    expect(error?.message).toBe('test mode not detected');
    expect(log).not.toContain('hold');
    expect(fills(log)).toEqual([]);
  });
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
