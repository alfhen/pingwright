import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { markdownToHtml } from 'satteri';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { ANNOT } from '../site/src/lib/annotations.ts';
import { PROMPT } from '../site/src/lib/prompt.ts';
import { docsUrl, newDocsContext, root } from './docs-test-helpers.ts';

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
});

const guides = ['/docs/guide/what-it-checks', '/docs/guide/first-run', '/docs/guide/reading-results'];
const annotationOf = (line: string) => ANNOT.find((annotation) => annotation.lines.includes(line))!;

const shownNote = (page: Page) =>
  page.locator('.annotated-note:visible').evaluateAll((notes) =>
    notes.map((note) => [note.querySelector('.annotated-title')?.textContent, note.querySelector('.annotated-body')?.textContent]),
  );
const activeLines = (page: Page) => page.locator('.annotated-line.is-active').allTextContents();

test('focusing each line of the annotated summary highlights its part and shows its explanation', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/guide/reading-results`, { waitUntil: 'networkidle' });
  const lines = page.locator('.annotated-summary .annotated-line');
  const texts = await lines.allTextContents();
  expect([...texts].sort()).toEqual(ANNOT.flatMap((annotation) => annotation.lines).sort());

  for (const [index, text] of [...texts.entries()].reverse()) {
    const annotation = annotationOf(text);
    await lines.nth(index).focus();
    expect(await shownNote(page), text).toEqual([[annotation.title, annotation.body]]);
    expect(await activeLines(page), text).toEqual(texts.filter((line) => annotation.lines.includes(line)));
    expect(await lines.nth(index).getAttribute('tabindex'), text).toBe('0');
  }
  await context.close();
});

test('the annotated summary follows the mouse and the arrow keys', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/guide/reading-results`, { waitUntil: 'networkidle' });
  const hits = ANNOT.find((annotation) => annotation.key === 'hits')!;
  expect(await shownNote(page)).toEqual([[hits.title, hits.body]]);

  await page.locator('.annotated-line', { hasText: 'Result: fail' }).hover();
  const result = annotationOf('Result: fail (3 of 5)');
  expect(await shownNote(page)).toEqual([[result.title, result.body]]);

  await page.locator('.annotated-line').first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const sgtm = annotationOf('  sgtm: (no event) x1');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('  sgtm: (no event) x1');
  expect(await shownNote(page)).toEqual([[sgtm.title, sgtm.body]]);
  await page.keyboard.press('End');
  expect(await page.evaluate(() => document.activeElement?.textContent)).toMatch(/^Record: /);
  await context.close();
});

test('on a 390 px screen the explanation shows under the summary, without sideways scrolling', async () => {
  const context = await newDocsContext(browser!, { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/guide/reading-results`, { waitUntil: 'networkidle' });
  const code = (await page.locator('.annotated-code').boundingBox())!;
  const panel = (await page.locator('.annotated-panel').boundingBox())!;
  expect(panel.y).toBeGreaterThanOrEqual(code.y + code.height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await context.close();
});

test('on GitHub the annotated summary is a plain text code block', async () => {
  const markdown = readFileSync(join(root, 'docs/guide/reading-results.md'), 'utf8');
  const fence = /^```text annotated\n([\s\S]*?)\n```$/m.exec(markdown);
  expect(fence).not.toBeNull();
  const html = (await markdownToHtml(fence![0])).html;
  expect(html).toMatch(/^<pre><code class="language-text">Hits\n/);
  expect(fence![1]!.split('\n').sort()).toEqual(ANNOT.flatMap((annotation) => annotation.lines).sort());
});

test('the agent callout on each guide page copies the setup prompt', async () => {
  const context = await newDocsContext(browser!);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: docsUrl });
  const page = await context.newPage();
  for (const path of guides) {
    await page.goto(`${docsUrl}${path}`, { waitUntil: 'networkidle' });
    const callout = page.locator('.agent-callout');
    expect(await callout.locator('.agent-callout-label').textContent(), path).toBe('// using an agent?');
    await page.evaluate(() => navigator.clipboard.writeText(''));
    const button = callout.locator('button');
    expect(await button.textContent(), path).toBe('Copy the agent setup prompt');
    await button.click();
    await expect.poll(() => button.textContent(), { message: path }).toBe('Copied. Paste into your agent');
    expect(await page.evaluate(() => navigator.clipboard.readText()), path).toBe(PROMPT);
  }
  for (const path of ['/docs/cli', '/readme']) {
    await page.goto(`${docsUrl}${path}`);
    expect(await page.locator('.agent-callout').count(), path).toBe(0);
  }
  await context.close();
});

test('the two-column tables of /docs/cli show as a reference list with a 170 px code column', async () => {
  const context = await newDocsContext(browser!, { viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/cli`, { waitUntil: 'networkidle' });
  const firstCell = page.locator('.sl-markdown-content table').first().locator('tbody td').first();
  const style = await firstCell.evaluate((cell) => {
    const css = getComputedStyle(cell);
    return { content: cell.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight), font: css.fontFamily, size: css.fontSize };
  });
  expect(style).toEqual({ content: 170, font: expect.stringContaining('Geist Mono'), size: '13px' });
  expect(await page.locator('.sl-markdown-content table').first().getByRole('columnheader', { name: 'Option' }).count()).toBe(1);

  await page.goto(`${docsUrl}/docs/guide/reading-results`, { waitUntil: 'networkidle' });
  const otherCell = page.locator('.sl-markdown-content table').first().locator('tbody td').first();
  expect(await otherCell.evaluate((cell) => getComputedStyle(cell).fontFamily)).not.toContain('Geist Mono');
  await context.close();
});

test('on a 390 px screen the docs content has the same 16 px side padding in both themes', async () => {
  for (const theme of ['dark', 'light']) {
    const context = await newDocsContext(browser!, { viewport: { width: 390, height: 844 } });
    await context.addInitScript((value) => localStorage.setItem('starlight-theme', value), theme);
    const page = await context.newPage();
    await page.goto(`${docsUrl}/docs/guide/reading-results`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => document.documentElement.dataset.theme), theme).toBe(theme);
    const padding = await page.locator('.content-panel').last().evaluate((panel) => getComputedStyle(panel).paddingLeft);
    expect(padding, theme).toBe('16px');
    expect((await page.locator('.sl-markdown-content').boundingBox())!.x, theme).toBe(16);
    await context.close();
  }
});
