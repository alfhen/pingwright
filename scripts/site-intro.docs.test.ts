import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromeUserAgent } from '../packages/recorder/src/user-agent.ts';
import { dist, docsUrl, newDocsContext } from './docs-test-helpers.ts';

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
});

const wide = { width: 1280, height: 800 };
const overlay = '[data-intro-overlay]';

/** A context with empty storage, as a first-time visitor has. Only this file opens pages without the shared helper. */
function firstVisitContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
  return browser!.newContext({ userAgent: chromeUserAgent(browser!.version()), viewport: wide, ...options });
}

/** Waits until the intro island has loaded and made its decision. */
async function openHome(page: Page): Promise<void> {
  await page.goto(`${docsUrl}/`);
  await page.waitForSelector('astro-island[component-url*="Intro"]:not([ssr])', { state: 'attached' });
  // The island drops `ssr` before its effects run; `open` replaces `pending` once the intro and its key listener are live.
  await page.waitForFunction(() => document.documentElement.dataset.intro !== 'pending');
}

const stage = (page: Page) => page.locator(overlay).getAttribute('data-stage', { timeout: 1000 }).catch(() => null);
const introSeen = (page: Page) => page.evaluate(() => localStorage.getItem('tagreeve.introSeen'));
const bodyOverflow = (page: Page) => page.evaluate(() => getComputedStyle(document.body).overflow);
const mainInert = (page: Page) => page.evaluate(() => document.querySelector('main')!.inert);

/** Colours inside the overlay that equal either theme's mint. */
function findMint(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    const mints = ['dark', 'light'].map((theme) => {
      const probe = document.createElement('div');
      probe.dataset.theme = theme;
      probe.style.color = 'var(--mint)';
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    const props = [
      'color',
      'background-color',
      'background-image',
      'border-top-color',
      'border-right-color',
      'border-bottom-color',
      'border-left-color',
      'outline-color',
      'box-shadow',
      'text-shadow',
    ];
    const root = document.querySelector(selector)!;
    const found: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const style = getComputedStyle(el);
      for (const prop of props) {
        const value = style.getPropertyValue(prop);
        if (mints.some((mint) => value.includes(mint))) found.push(`${el.tagName.toLowerCase()} ${prop}: ${value}`);
      }
    }
    return found;
  }, overlay);
}

test('the intro shows on a first visit at 1280 px, locks scroll and makes the page underneath inert', async () => {
  const context = await firstVisitContext();
  const page = await context.newPage();
  await openHome(page);
  expect(await stage(page)).toBe('ask');
  expect(await page.getByRole('dialog', { name: 'The 5-minute ticket' }).isVisible()).toBe(true);
  expect(await page.getByText('Quick favour? Meta numbers + consent').first().isVisible()).toBe(true);
  expect(await bodyOverflow(page)).toBe('hidden');
  expect(await mainInert(page)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.dataset.intro)).toBe('open');
  expect(await introSeen(page)).toBe(null);
  await context.close();
});

for (const [name, options] of [
  ['at 800 px', { viewport: { width: 800, height: 800 } }],
  ['with reduced motion', { reducedMotion: 'reduce' }],
] as const) {
  test(`the intro does not show ${name}`, async () => {
    const context = await firstVisitContext(options);
    const page = await context.newPage();
    await openHome(page);
    expect(await page.locator(overlay).count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.dataset.intro)).toBeUndefined();
    expect(await bodyOverflow(page)).not.toBe('hidden');
    await context.close();
  });
}

test('the intro does not show with the flag set, so the docs tests that use the shared helper never see it', async () => {
  const context = await newDocsContext(browser!, { viewport: wide });
  const fonts: string[] = [];
  context.on('request', (request) => {
    if (/anton/i.test(request.url())) fonts.push(request.url());
  });
  const page = await context.newPage();
  await openHome(page);
  await page.waitForLoadState('networkidle');
  expect(await page.locator(overlay).count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.dataset.intro)).toBeUndefined();
  expect(await mainInert(page)).toBe(false);
  expect(fonts, 'Anton loads only when the intro opens').toEqual([]);
  await context.close();
});

test('a storage error never blocks the page: the intro then does not show', async () => {
  const context = await firstVisitContext();
  await context.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage is off', 'SecurityError');
      },
    });
  });
  const page = await context.newPage();
  await openHome(page);
  expect(await page.locator(overlay).count()).toBe(0);
  expect(await page.locator('h1').isVisible()).toBe(true);
  expect(await bodyOverflow(page)).not.toBe('hidden');
  await context.close();
});

for (const skip of ['Skip intro →', 'Not my job (skip)']) {
  test(`"${skip}" sets the flag, unlocks scroll and removes the intro`, async () => {
    const context = await firstVisitContext();
    const page = await context.newPage();
    await openHome(page);
    await page.getByRole('button', { name: skip }).click();
    expect(await introSeen(page)).toBe('1');
    await expect.poll(() => page.locator(overlay).count(), { timeout: 5000 }).toBe(0);
    expect(await bodyOverflow(page)).not.toBe('hidden');
    expect(await mainInert(page)).toBe(false);
    expect(await page.evaluate(() => document.querySelector('main')!.style.animation)).toBe('');
    await page.reload();
    await page.waitForSelector('astro-island[component-url*="Intro"]:not([ssr])', { state: 'attached' });
    expect(await page.locator(overlay).count()).toBe(0);
    await context.close();
  });
}

test('Escape skips the intro', async () => {
  const context = await firstVisitContext();
  const page = await context.newPage();
  await openHome(page);
  await page.keyboard.press('Escape');
  expect(await introSeen(page)).toBe('1');
  await expect.poll(() => page.locator(overlay).count(), { timeout: 5000 }).toBe(0);
  await context.close();
});

test('the footer replay link opens the intro again with the flag set', async () => {
  const context = await newDocsContext(browser!, { viewport: wide });
  const page = await context.newPage();
  await openHome(page);
  expect(await page.locator(overlay).count()).toBe(0);
  await page.getByRole('button', { name: 'replay the 5-minute ticket' }).click();
  expect(await stage(page)).toBe('ask');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await bodyOverflow(page)).toBe('hidden');
  await page.getByRole('button', { name: 'Skip intro →' }).click();
  await expect.poll(() => page.locator(overlay).count(), { timeout: 5000 }).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('replay the 5-minute ticket');
  await context.close();
});

for (const [name, options] of [
  ['with reduced motion', { viewport: wide, reducedMotion: 'reduce' }],
  ['at 390 px', { viewport: { width: 390, height: 844 } }],
] as const) {
  test(`replay does not open the intro ${name}, and the replay link is hidden`, async () => {
    const context = await newDocsContext(browser!, options);
    const page = await context.newPage();
    await openHome(page);
    expect(await page.getByText('replay the 5-minute ticket').isHidden()).toBe(true);
    await page.evaluate(async () => {
      window.dispatchEvent(new Event('tagreeve:replay-intro'));
      for (let frame = 0; frame < 2; frame++) await new Promise(requestAnimationFrame);
    });
    expect(await page.locator(overlay).count()).toBe(0);
    expect(await bodyOverflow(page)).not.toBe('hidden');
    expect(await mainInert(page)).toBe(false);
    await context.close();
  });
}

test('no element inside the intro uses either theme mint, at any stage', async () => {
  for (const theme of ['dark', 'light']) {
    const context = await firstVisitContext();
    await context.addInitScript((value) => localStorage.setItem('starlight-theme', value), theme);
    const page = await context.newPage();
    await openHome(page);
    expect(await findMint(page), `${theme} ask`).toEqual([]);
    if (theme === 'dark') {
      await page.getByRole('button', { name: 'Reply: "Sure, I\'ll take a look"' }).click();
      await page.getByRole('button', { name: 'Meta - Purchase NEW' }).click();
      expect(await page.locator('[data-intro-selected]').textContent()).toBe('Meta - Purchase NEW');
      await page.getByRole('button', { name: 'Preview' }).click();
      await page.getByRole('button', { name: 'Try again' }).click();
      expect(await page.locator('[data-intro-attempt]').textContent()).toContain('Attempt 5 of ∞.');
      await page.locator('[data-intro-shake]').waitFor({ timeout: 10_000 });
      expect(await page.locator('[data-intro-notification]').count()).toBeGreaterThanOrEqual(10);
      expect(await findMint(page), 'mess').toEqual([]);
      await expect.poll(() => stage(page), { timeout: 10_000 }).toBe('wasted');
      expect(await findMint(page), 'wasted').toEqual([]);
      // The check must be able to fail: an element in the site's mint is caught.
      await page.evaluate((selector) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--mint)';
        document.querySelector(selector)!.append(probe);
      }, overlay);
      expect(await findMint(page)).not.toEqual([]);
    }
    await context.close();
  }
});

test('the run from Reply to the end of fly plays every stage, then unmounts the overlay, without outside requests', async () => {
  const context = await firstVisitContext();
  const outside: string[] = [];
  const fonts: string[] = [];
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (url.hostname !== '127.0.0.1') outside.push(request.url());
    if (/anton/i.test(url.pathname)) fonts.push(url.pathname);
  });
  const page = await context.newPage();
  await openHome(page);
  await expect.poll(() => fonts.length, { message: 'Anton loads when the intro opens' }).toBeGreaterThan(0);
  const stages = page.evaluate(
    (selector) =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        const record = () => {
          const value = document.querySelector(selector)?.getAttribute('data-stage');
          if (value && seen.at(-1) !== value) seen.push(value);
        };
        record();
        new MutationObserver(() => {
          record();
          if (!document.querySelector(selector)) resolve(seen);
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-stage'] });
      }),
    overlay,
  ).catch((error: unknown) => [String(error)]);
  await page.getByRole('button', { name: 'Reply: "Sure, I\'ll take a look"' }).click();
  await expect.poll(() => stage(page), { timeout: 10_000 }).toBe('wasted');
  expect(await page.locator('[data-intro-notification]').count()).toBe(13);
  expect(await page.locator('[data-intro-unread]').textContent()).toBe('14');
  expect(await page.locator('[data-intro-time]').textContent()).toBe('3h 19m');
  await page.getByText('3h 19m in the tag manager. Meta still fires before consent.').waitFor();
  expect(await page.evaluate(() => document.fonts.check('1em Anton', 'wasted'))).toBe(true);
  expect(await introSeen(page)).toBe(null);
  await expect.poll(() => introSeen(page), { timeout: 5000 }).toBe('1');
  expect(await stages).toEqual(['ask', 'mess', 'wasted', 'shrink', 'fly']);
  expect(await page.locator(overlay).count()).toBe(0);
  expect(await bodyOverflow(page)).not.toBe('hidden');
  expect(await mainInert(page)).toBe(false);
  await context.close();
  expect(outside).toEqual([]);
});

for (const viewport of [
  { width: 860, height: 700 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
]) {
  test(`all 13 notifications stay inside the screen at ${viewport.width}x${viewport.height}`, async () => {
    const context = await firstVisitContext({ viewport });
    const page = await context.newPage();
    await openHome(page);
    await page.getByRole('button', { name: 'Reply: "Sure, I\'ll take a look"' }).click();
    await expect.poll(() => stage(page), { timeout: 10_000 }).toBe('wasted');
    expect(await page.locator('[data-intro-notification]').count()).toBe(13);
    const outside: string[] = [];
    while ((await stage(page)) === 'wasted') {
      outside.push(
        ...(await page.evaluate(() =>
          [...document.querySelectorAll('[data-intro-notification]')].flatMap((el, i) => {
            const r = el.getBoundingClientRect();
            const inside = r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
            return inside ? [] : [`#${i}: ${[r.left, r.top, r.right, r.bottom].map(Math.round).join(',')} in ${innerWidth}x${innerHeight}`];
          }),
        )),
        ...(await page.evaluate(() => {
          const cards = [...document.querySelectorAll('[data-intro-notification]')].slice(0, 4).map((el) => el.getBoundingClientRect());
          return cards.flatMap((r, i) => (i > 0 && r.top < cards[i - 1]!.bottom ? [`stack card ${i} overlaps card ${i - 1} by ${Math.round(cards[i - 1]!.bottom - r.top)}px`] : []));
        })),
      );
      await page.waitForTimeout(100);
    }
    expect(outside).toEqual([]);
    await context.close();
  });
}

test('the page under the intro is complete HTML, and the intro adds nothing without JavaScript', async () => {
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const island = /<astro-island[^>]*component-url="[^"]*Intro[^"]*"[^>]*>([\s\S]*?)<\/astro-island>/.exec(html);
  expect(island, 'the intro island').not.toBeNull();
  expect(island![1]!.replace(/<template[^>]*>[\s\S]*?<\/template>/g, '').trim()).toBe('');
  expect(html).not.toContain('Quick favour?');

  const context = await firstVisitContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`);
  expect(await page.locator('h1').textContent()).toContain('"Should only take 5 minutes."');
  expect(await page.locator(overlay).count()).toBe(0);
  expect(await page.getByText('Skip intro →').count()).toBe(0);
  await context.close();
});

test('no built file contains northwind.dk, and the intro names the .example host', () => {
  const old = spawnSync('grep', ['-rl', 'northwind.dk', dist], { encoding: 'utf8' });
  expect(old.stdout).toBe('');
  const example = spawnSync('grep', ['-rl', 'www.northwind.example', join(dist, '_astro')], { encoding: 'utf8' });
  expect(example.stdout).not.toBe('');
});
