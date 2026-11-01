import type { BrowserContext, Page } from 'playwright';
import { expect, test } from 'vitest';
import { conditionHolds, describeCondition, formatDuration, urlMatches, watchCondition } from './conditions.ts';

test('a glob matches the path and query, not the origin', () => {
  const glob = { glob: '/thank-you*' };
  expect(urlMatches(glob, 'http://localhost:3000/thank-you-late')).toBe(true);
  expect(urlMatches(glob, 'http://localhost:3000/thank-you?order=1')).toBe(true);
  expect(urlMatches(glob, 'http://localhost:3000/cart?next=/thank-you')).toBe(false);
  expect(urlMatches({ glob: '/orders/*/done' }, 'https://shop.example.com/orders/42/done')).toBe(true);
  expect(urlMatches({ glob: '/a' }, 'not a url')).toBe(false);
});

test('matches is a regular expression over the whole URL', () => {
  const m = { matches: '^https://shop\\.example\\.com/.*/thank_you$' };
  expect(urlMatches(m, 'https://shop.example.com/1/thank_you')).toBe(true);
  expect(urlMatches(m, 'https://other.example.com/1/thank_you')).toBe(false);
});

function fakePage(url: string, visible: Record<string, boolean> = {}): Page {
  const locator = (selector: string) => ({ first: () => ({ isVisible: async () => visible[selector] === true }) });
  return {
    url: () => url,
    locator,
    getByRole: (role: string, o: { name?: string }) => locator(`${role}:${o.name ?? ''}`),
  } as unknown as Page;
}

const contextOf = (...pages: Page[]) => ({ pages: () => pages }) as unknown as BrowserContext;

test('a url condition holds when any page in the context matches', async () => {
  const context = contextOf(fakePage('http://localhost/cart'), fakePage('http://localhost/thank-you'));
  expect(await conditionHolds(context, { url: { glob: '/thank-you' } })).toBe(true);
  expect(await conditionHolds(context, { url: { glob: '/nope' } })).toBe(false);
});

test('a locator condition holds when the element is visible on a second page', async () => {
  const context = contextOf(fakePage('http://localhost/a'), fakePage('http://localhost/b', { '#ok': true, 'heading:Thank you': true }));
  expect(await conditionHolds(context, { locator: '#ok' })).toBe(true);
  expect(await conditionHolds(context, { locator: { any: ['#missing', '#ok'] } })).toBe(true);
  expect(await conditionHolds(context, { locator: { role: 'heading', name: 'Thank you' } })).toBe(true);
  expect(await conditionHolds(context, { locator: '#missing' })).toBe(false);
});

test('a page that throws does not hold the condition', async () => {
  const broken = {
    url: () => {
      throw new Error('closed');
    },
  } as unknown as Page;
  expect(await conditionHolds(contextOf(broken), { url: { glob: '/x' } })).toBe(false);
});

test('watchCondition resolves on a match and stays pending after an abort', async () => {
  const pages: Page[] = [fakePage('http://localhost/a')];
  const context = { pages: () => pages } as unknown as BrowserContext;
  let matched = false;
  void watchCondition(context, { url: { glob: '/b' } }, new AbortController().signal).then(() => void (matched = true));
  await new Promise((r) => setTimeout(r, 250));
  expect(matched).toBe(false);
  pages.push(fakePage('http://localhost/b'));
  await expect.poll(() => matched).toBe(true);

  const stopped = new AbortController();
  let leaked = false;
  void watchCondition(context, { url: { glob: '/never' } }, stopped.signal).then(() => void (leaked = true));
  stopped.abort();
  pages.push(fakePage('http://localhost/never'));
  await new Promise((r) => setTimeout(r, 250));
  expect(leaked).toBe(false);
});

test('the condition is described as written', () => {
  expect(describeCondition({ url: { glob: '/thank-you*' } })).toBe('/thank-you*');
  expect(describeCondition({ url: { matches: 'ty$' } })).toBe('matches ty$');
  expect(describeCondition({ locator: '#ok' })).toBe('#ok');
  expect(describeCondition({ locator: { role: 'heading', name: 'Thank you' } })).toBe('heading "Thank you"');
  expect(describeCondition({ locator: { any: ['#a', '#b'] } })).toBe('any of #a, #b');
});

test('durations print in the largest whole unit', () => {
  expect([600_000, 90_000, 1500, 1000, 500].map(formatDuration)).toEqual(['10m', '90s', '1500ms', '1s', '500ms']);
});
