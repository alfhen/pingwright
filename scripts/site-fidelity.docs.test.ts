import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { docsUrl, newDocsContext } from './docs-test-helpers.ts';

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
});

async function openHome(width: number): Promise<Page> {
  const context = await newDocsContext(browser!, { viewport: { width, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`);
  await page.evaluate(() => document.fonts.ready);
  return page;
}

for (const width of [1440, 1920]) {
  test(`the header, each home section and the footer have the handoff's 1280 px content box at ${width} px`, async () => {
    const page = await openHome(width);
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('.site-header, main > section, body > footer > div')].map((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const left = r.left + parseFloat(style.paddingLeft);
        const contentWidth = r.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? ` ${el.getAttribute('aria-label')}` : ''}: ${Math.round(left)} +${Math.round(contentWidth)}`;
      }),
    );
    expect(boxes).toHaveLength(9);
    const left = (width - 1280) / 2;
    for (const box of boxes) expect(box).toMatch(new RegExp(`: ${left} \\+1280$`));
    await page.context().close();
  });
}

async function headerFrame(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.site-header')!;
    const style = getComputedStyle(header);
    const probe = document.createElement('div');
    probe.style.marginInlineStart = 'var(--frame-start)';
    document.body.append(probe);
    const frameStart = probe.getBoundingClientRect().left;
    probe.remove();
    return {
      left: header.getBoundingClientRect().left + parseFloat(style.paddingLeft),
      frameStart,
      lineHeights: [...header.querySelectorAll('a, button, span')]
        .filter((el) => el.textContent!.trim())
        .map((el) => `${el.textContent!.trim().slice(0, 30)}: ${getComputedStyle(el).lineHeight}`),
    };
  });
}

for (const width of [1440, 1920]) {
  test(`the header on /docs/cli has the home header's frame and line heights at ${width} px, and --frame-start marks its left edge`, async () => {
    const home = await openHome(width);
    const onHome = await headerFrame(home);
    await home.goto(`${docsUrl}/docs/cli`);
    const onDocs = await headerFrame(home);
    expect(onHome.left).toBe((width - 1280) / 2);
    expect(onDocs.left).toBe(onHome.left);
    expect([onHome.frameStart, onDocs.frameStart]).toEqual([onHome.left, onHome.left]);
    expect(onDocs.lineHeights.filter((h) => !h.endsWith(': normal'))).toEqual([]);
    expect(onDocs.lineHeights).toEqual(onHome.lineHeights);
    await home.context().close();
  });
}

test('the header keeps its 16 px side padding at 390 px', async () => {
  const page = await openHome(390);
  expect(await page.locator('.site-header').evaluate((el) => getComputedStyle(el).paddingInline)).toBe('16px');
  await page.context().close();
});

for (const width of [1440, 390]) {
  test(`every line of each command panel fits inside the panel at ${width} px`, async () => {
    const page = await openHome(width);
    const overflow: string[] = [];
    for (const key of ['run', 'diff', 'suite', 'json']) {
      await page.locator(`button[data-command="${key}"]`).click();
      const panel = page.locator(`[data-command-panel="${key}"]`);
      overflow.push(
        ...(await panel.evaluate((el, name) => {
          const box = el.getBoundingClientRect();
          const right = box.right - parseFloat(getComputedStyle(el).paddingRight) - parseFloat(getComputedStyle(el).borderRightWidth);
          const lines = [...el.querySelectorAll('[data-command-line]')];
          const wide = lines.filter((line) => line.getBoundingClientRect().right > right + 0.5 || line.scrollWidth > line.clientWidth);
          const scrolls = el.scrollWidth > el.clientWidth ? [`${name}: the panel scrolls sideways`] : [];
          return lines.length ? [...scrolls, ...wide.map((line) => `${name}: ${line.textContent!.trim().slice(0, 60)}`)] : [`${name}: no lines`];
        }, key)),
      );
    }
    expect(overflow).toEqual([]);
    await page.context().close();
  });
}

test('home text without its own line height uses the normal line height, as the handoff sets sizes with the font shorthand', async () => {
  const page = await openHome(1440);
  const heights = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        '.site-header a, .site-header button, main > section:first-child button, [data-command] > span, .ad-picker button, .ad-replay, footer span',
      ),
    ].map((el) => `${el.textContent!.trim().slice(0, 30)}: ${getComputedStyle(el).lineHeight}`),
  );
  expect(heights.length).toBeGreaterThan(10);
  expect(heights.filter((h) => !h.endsWith(': normal'))).toEqual([]);
  await page.context().close();
});

test('the agent demo prompt card is 620 px wide plus its padding and border, as in the handoff', async () => {
  const page = await openHome(1440);
  expect(await page.locator('.ad-ask').evaluate((el) => (el as HTMLElement).offsetWidth)).toBe(658);
  await page.context().close();
});
