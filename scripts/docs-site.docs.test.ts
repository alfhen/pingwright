import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PROMPT } from '../site/src/lib/prompt.ts';
import { buildDocs, dist, docsUrl, newDocsContext, root } from './docs-test-helpers.ts';

let browser: Browser | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
});

const guides = ['/docs/guide/what-it-checks', '/docs/guide/first-run', '/docs/guide/reading-results'];
const published = ['/', '/readme', ...guides, '/docs/cli', '/docs/design', '/docs/shopify-checkout'];
const diagramPages = ['/docs/design', ...guides];

test('builds the home page as /, the README as /readme, the guides and every published doc', () => {
  for (const path of published) {
    const file = path === '/' ? 'index.html' : `${path.slice(1)}.html`;
    expect(existsSync(join(dist, file)), path).toBe(true);
  }
  for (const absent of ['docs/plan-0.2', 'docs/plan-site', 'docs/proposal-docs-site', 'docs/goals', 'docs/release', 'docs/index', 'docs', 'CHANGELOG', 'AGENTS', 'brand/site-handoff/README']) {
    expect(existsSync(join(dist, `${absent}.html`)), absent).toBe(false);
    expect(existsSync(join(dist, absent, 'index.html')), absent).toBe(false);
  }
});

test('the build output has no outside fonts or URLs in src, stylesheet href or url(), and no dead links', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-docs-dist.ts'), dist], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

test('no built file names the store host northwind.dk', () => {
  const result = spawnSync('grep', ['-rl', 'northwind.dk', dist], { encoding: 'utf8' });
  expect(result.stdout).toBe('');
});

test('each published page has exactly one h1', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  for (const path of published) {
    await page.goto(`${docsUrl}${path}`);
    expect(await page.locator('h1').count(), path).toBe(1);
  }
  await context.close();
});

describe('builds that must fail', () => {
  const scratch = join(root, 'node_modules/.cache/tagreeve-docs-test');
  const firstRun = join(root, 'docs/guide/first-run.md');
  const unlisted = join(root, 'docs/zz-unlisted.md');

  beforeAll(() => mkdirSync(scratch, { recursive: true }));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  test('a dead page link or a dead fragment in a published page fails the build and names both', () => {
    const original = readFileSync(firstRun, 'utf8');
    let result: ReturnType<typeof buildDocs>;
    try {
      writeFileSync(firstRun, `${original}\n[nowhere](./does-not-exist)\n\n[gone](./reading-results.md#no-such-heading)\n`);
      result = buildDocs(join(scratch, 'dead-links'));
    } finally {
      writeFileSync(firstRun, original);
    }
    const output = result.stdout + result.stderr;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain('does-not-exist');
    expect(output).toContain('#no-such-heading');
  });

  test('a page the sidebar does not list fails the build and names the file', () => {
    let result: ReturnType<typeof buildDocs>;
    try {
      writeFileSync(unlisted, '# Unlisted\n\nA valid page that the sidebar does not link to.\n');
      result = buildDocs(join(scratch, 'unlisted'));
    } finally {
      rmSync(unlisted, { force: true });
    }
    const output = result.stdout + result.stderr;
    expect(result.status, output).not.toBe(0);
    expect(output).toContain('Pages not in the published list: docs/zz-unlisted.md');
  });
});

test('search finds a word from docs/cli.md', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/guide/first-run`);
  await page.locator('button[data-open-modal]').click();
  await page.locator('.pagefind-ui__search-input').fill('install-browser');
  const hit = page.locator('.pagefind-ui__result-link[href*="/docs/cli"]').first();
  await hit.waitFor();
  expect(await hit.getAttribute('href')).toContain('/docs/cli');
  await context.close();
});

test('the first-run guide copies the get started prompt', async () => {
  const context = await newDocsContext(browser!);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: docsUrl });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/guide/first-run`);
  await page.getByRole('button', { name: 'Copy get started prompt' }).click();
  await expect.poll(() => page.locator('.get-started-status').textContent()).toBe('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);
  expect(await page.locator('.get-started-text').textContent()).toBe(PROMPT);
  await context.close();
});

test('the hero copies the setup prompt and the npm command', async () => {
  const context = await newDocsContext(browser!);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: docsUrl });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`);
  const promptButton = page.locator('button[data-copy-from="hero-prompt"]');
  expect(await promptButton.textContent()).toBe('Copy the agent setup prompt');
  await promptButton.click();
  await expect.poll(() => promptButton.textContent()).toBe('Copied. Paste into your agent');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT);

  const npmButton = page.locator('button[data-copy-text]');
  expect(await npmButton.textContent()).toBe('$ npm i -g tagreeve@next');
  await npmButton.click();
  await expect.poll(() => npmButton.textContent()).toBe('✓ copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('npm i -g tagreeve@next');
  await context.close();
});

test('the home page has the hero and the footer, and the replay link dispatches tagreeve:replay-intro', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`);
  await expect.poll(() => page.locator('h1').textContent()).toContain('"Should only take 5 minutes." Now it does.');
  expect(await page.getByText('0.4 release candidate · Chromium · MIT').count()).toBe(1);
  expect(await page.getByText('tagreeve · MIT · runs on infrastructure you control').count()).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { replays: number }).replays = 0;
    window.addEventListener('tagreeve:replay-intro', () => (window as unknown as { replays: number }).replays++);
  });
  await page.getByRole('button', { name: 'replay the 5-minute ticket' }).click();
  expect(await page.evaluate(() => (window as unknown as { replays: number }).replays)).toBe(1);
  await context.close();
});

test('the theme chosen on / holds on /docs/cli after a reload', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await page.getByRole('button', { name: '☀ light' }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  await page.goto(`${docsUrl}/docs/cli`);
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
  expect(await page.getByRole('button', { name: '☾ dark' }).isVisible()).toBe(true);
  await context.close();
});

test('/ at 390 px has no sideways scroll and shows the ☰ button, which opens the links', async () => {
  const context = await newDocsContext(browser!, { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(`${docsUrl}/`, { waitUntil: 'networkidle' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const menu = page.getByRole('button', { name: 'Menu' });
  expect(await menu.isVisible()).toBe(true);
  expect(await page.getByRole('navigation', { name: 'Main' }).isVisible()).toBe(false);
  await menu.click();
  expect(await page.locator('#site-menu').getByRole('link', { name: 'CLI reference' }).isVisible()).toBe(true);
  await context.close();
});

test('/readme loads lockup.svg and lockup-dark.svg and shows the one for the theme', async () => {
  for (const theme of ['dark', 'light']) {
    const context = await newDocsContext(browser!);
    await context.addInitScript((value) => localStorage.setItem('starlight-theme', value), theme);
    const statuses = new Map<string, number>();
    context.on('response', (response) => statuses.set(new URL(response.url()).pathname, response.status()));
    const page = await context.newPage();
    await page.goto(`${docsUrl}/readme`, { waitUntil: 'networkidle' });
    expect(statuses.get('/lockup.svg'), theme).toBe(200);
    expect(statuses.get('/lockup-dark.svg'), theme).toBe(200);
    const shown = page.locator(theme === 'dark' ? 'img.theme-dark' : 'img.theme-light');
    const hidden = page.locator(theme === 'dark' ? 'img.theme-light' : 'img.theme-dark');
    expect(await shown.isVisible(), theme).toBe(true);
    expect(await hidden.isVisible(), theme).toBe(false);
    expect(await shown.evaluate((img: HTMLImageElement) => img.naturalWidth), theme).toBeGreaterThan(0);
    await context.close();
  }
});

test('built pages make no requests to other hosts', async () => {
  const context = await newDocsContext(browser!);
  const outside: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url());
  });
  const page = await context.newPage();
  for (const path of [...published, '/no-such-page']) {
    await page.goto(`${docsUrl}${path}`, { waitUntil: 'networkidle' });
  }
  await context.close();
  expect(outside).toEqual([]);
});

test('pages store nothing but the theme and the intro flag, and set no cookie', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  for (const path of ['/', '/docs/cli', '/docs/guide/first-run']) {
    await page.goto(`${docsUrl}${path}`, { waitUntil: 'networkidle' });
    await page.locator('[data-theme-toggle]').click();
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    const stored = await page.evaluate(() => ({ local: Object.keys(localStorage).sort(), session: Object.keys(sessionStorage) }));
    expect(stored, path).toEqual({ local: ['starlight-theme', 'tagreeve.introSeen'], session: [] });
  }
  expect(await context.cookies()).toEqual([]);
  await context.close();
});

test('a page with a diagram draws an svg, in light and dark mode, without outside requests', async () => {
  const context = await newDocsContext(browser!);
  const outside: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url());
  });
  const page = await context.newPage();
  for (const path of diagramPages) {
    await page.goto(`${docsUrl}${path}`, { waitUntil: 'networkidle' });
    await page.locator('.mermaid-svg svg').first().waitFor();
    const drawn = await page.locator('.mermaid-diagram').count();
    expect(await page.locator('.mermaid-svg svg').count(), path).toBe(drawn);
    expect(await page.locator('.mermaid-source').count(), path).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
  }
  const nodeFill = () => page.locator('.mermaid-svg svg .node rect').first().evaluate((el) => getComputedStyle(el).fill);
  const darkFill = await nodeFill();
  await page.locator('[data-theme-toggle]').click();
  await expect.poll(nodeFill).not.toBe(darkFill);
  await context.close();
  expect(outside).toEqual([]);
});

test('diagrams fit a 390 px phone screen without sideways scrolling', async () => {
  const context = await newDocsContext(browser!, { viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  for (const path of diagramPages) {
    await page.goto(`${docsUrl}${path}`, { waitUntil: 'networkidle' });
    await page.locator('.mermaid-svg svg').first().waitFor();
    const overflowing = await page.locator('.mermaid-svg').evaluateAll((boxes) =>
      boxes.filter((box) => box.scrollWidth > box.clientWidth).map((box) => `${box.scrollWidth} > ${box.clientWidth}`),
    );
    expect(overflowing, path).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
  }
  await context.close();
});

test('pages without a diagram do not load the diagram code', async () => {
  const context = await newDocsContext(browser!);
  const scripts: { url: string; bytes: number }[] = [];
  context.on('response', async (response) => {
    if (response.request().resourceType() !== 'script' || response.status() !== 200) return;
    scripts.push({ url: response.url(), bytes: (await response.body()).length });
  });
  const page = await context.newPage();
  const total = () => scripts.reduce((sum, script) => sum + script.bytes, 0);
  const diagramChunk = /mermaid|dagre|cytoscape|flowDiagram/i;

  await page.goto(`${docsUrl}/docs/cli`, { waitUntil: 'networkidle' });
  expect(scripts.filter((script) => diagramChunk.test(script.url))).toEqual([]);
  const withoutDiagram = total();
  expect(withoutDiagram).toBeLessThan(400_000);

  scripts.length = 0;
  await page.goto(`${docsUrl}/docs/guide/first-run`, { waitUntil: 'networkidle' });
  await context.close();
  expect(scripts.some((script) => diagramChunk.test(script.url))).toBe(true);
  expect(total()).toBeGreaterThan(withoutDiagram * 3);
});

test('every place that runs the Astro CLI turns telemetry off', () => {
  const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  const astroScripts = Object.entries(scripts).filter(([, command]) => /\bastro\b/.test(command));
  expect(astroScripts.map(([name]) => name).sort()).toEqual(['docs:build', 'docs:preview', 'typecheck']);
  for (const [name, command] of astroScripts) {
    for (const call of command.split('&&').filter((part) => /\bastro\b/.test(part))) {
      expect(call, name).toMatch(/ASTRO_TELEMETRY_DISABLED=1 astro /);
    }
  }
  for (const file of ['scripts/docs-global-setup.ts', '.github/workflows/docs.yml', '.github/workflows/ci.yml']) {
    expect(readFileSync(join(root, file), 'utf8'), file).toMatch(/ASTRO_TELEMETRY_DISABLED: '?1'?|ASTRO_TELEMETRY_DISABLED = '1'/);
  }
});
