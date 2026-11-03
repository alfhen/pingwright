import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { docsUrl, newDocsContext, root } from './docs-test-helpers.ts';

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
});

const demoFile = (name: string) => readFileSync(join(root, 'site/demo', name), 'utf8');

/** Opens `/` with the island hydrated and the page clock under the test's control. */
async function openHome(options: BrowserContextOptions = {}): Promise<Page> {
  const context = await newDocsContext(browser!, { viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`);
  await page.locator('astro-island:not([ssr])').waitFor({ state: 'attached' });
  await page.clock.install();
  return page;
}

const shown = (page: Page) =>
  page.evaluate(() => {
    const has = (name: string) => document.querySelector(`[data-demo="${name}"]`) !== null;
    return { idle: has('idle'), hit: has('hit'), verdict: has('verdict'), reply: has('reply'), sent: has('sent'), thanks: has('thanks') };
  });

describe('the agent demo', () => {
  test.each([
    ['undecided', 'ignores banner'],
    ['reject', 'rejects'],
    ['accept', 'accepts'],
  ])('for a visitor who %s, the first hit, the verdict, the reply and the thank-you appear in order', async (key, label) => {
    const page = await openHome();
    expect((await shown(page)).idle).toBe(true);
    expect(await page.getByText('Hits will land here as the visitor browses.').isVisible()).toBe(true);
    const pick = page.locator(`[data-demo-pick="${key}"]`);
    expect(await pick.textContent()).toBe(label);
    await pick.click();
    expect(await pick.getAttribute('aria-pressed')).toBe('true');
    expect((await shown(page)).idle).toBe(true);
    await page.locator('[data-demo="ask"]').click();
    expect((await shown(page)).idle).toBe(false);

    const firstSeen: Record<string, number> = {};
    for (let step = 1; step <= 160 && !('thanks' in firstSeen); step++) {
      await page.clock.runFor(160);
      for (const [name, on] of Object.entries(await shown(page))) if (on && !(name in firstSeen)) firstSeen[name] = step;
    }
    expect(Object.keys(firstSeen)).toEqual(expect.arrayContaining(['hit', 'verdict', 'reply', 'sent', 'thanks']));
    expect(firstSeen.hit!).toBeLessThan(firstSeen.verdict!);
    expect(firstSeen.verdict!).toBeLessThan(firstSeen.reply!);
    expect(firstSeen.reply!).toBeLessThan(firstSeen.sent!);
    expect(firstSeen.sent!).toBeLessThan(firstSeen.thanks!);

    const tool = await page.locator('[data-demo="tool"]').textContent();
    expect(tool).toContain(`tagreeve run tagreeve/${key}.yml --site https://staging.northwind.example`);
    const record = /^Record: .*$/m.exec(demoFile(`${key}.txt`))![0];
    expect(tool).toContain(record);
    const evidence = /hit_…[0-9A-Z]{4}/.exec(demoFile(`${key}.reply.md`))![0];
    expect(await page.locator('[data-demo="reply"]').textContent()).toContain(evidence);
    await page.context().close();
  });

  test('with reduced motion, Ask jumps to the final state', async () => {
    const page = await openHome({ reducedMotion: 'reduce' });
    await page.locator('[data-demo="ask"]').click();
    const state = await shown(page);
    expect(state).toMatchObject({ idle: false, hit: true, verdict: true, reply: true, sent: true, thanks: false });
    expect(await page.locator('[data-demo="reply"]').textContent()).toContain('Evidence:');
    await page.context().close();
  });

  test('replay and a new visitor choice restart the run', async () => {
    const page = await openHome();
    await page.locator('[data-demo="ask"]').click();
    await page.clock.runFor(9000);
    expect((await shown(page)).verdict).toBe(true);
    await page.locator('[data-demo="replay"]').click();
    expect(await shown(page)).toMatchObject({ verdict: false, hit: false });
    expect(await page.locator('[data-demo="clock"]').textContent()).toMatch(/^t = 1\.[45]s$/);
    await page.clock.runFor(9000);
    expect((await shown(page)).verdict).toBe(true);
    await page.locator('[data-demo-pick="accept"]').click();
    expect(await shown(page)).toMatchObject({ verdict: false, hit: false });
    await page.clock.runFor(9000);
    expect(await page.locator('[data-demo="epoch"]').textContent()).toBe('granted');
    await page.context().close();
  });
});

describe('the commands section', () => {
  const panels = {
    run: /^Record: .*$/m.exec(demoFile('reject.txt'))![0],
    diff: demoFile('diff.txt').split('\n')[0]!,
    suite: /^Manifest: .*$/m.exec(demoFile('suite.txt'))![0],
    json: /evidence: (hit_\w+)/.exec(demoFile('reject.txt'))![1]!,
  };

  test('the four rows switch the panel to their recorded output', async () => {
    const context = await newDocsContext(browser!);
    const page = await context.newPage();
    await page.goto(`${docsUrl}/`);
    for (const [key, text] of Object.entries(panels)) {
      await page.locator(`button[data-command="${key}"]`).click();
      expect(await page.locator(`button[data-command="${key}"]`).getAttribute('aria-pressed')).toBe('true');
      const visible = page.locator('[data-command-panel]:visible');
      expect(await visible.count()).toBe(1);
      expect(await visible.getAttribute('data-command-panel')).toBe(key);
      expect(await visible.textContent()).toContain(text);
    }
    await context.close();
  });

  test('the first row is in the HTML and shows without JavaScript', async () => {
    const context = await newDocsContext(browser!, { javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`${docsUrl}/`);
    const visible = page.locator('[data-command-panel]:visible');
    expect(await visible.count()).toBe(1);
    expect(await visible.getAttribute('data-command-panel')).toBe('run');
    expect(await visible.textContent()).toContain(panels.run);
    await context.close();
  });
});
