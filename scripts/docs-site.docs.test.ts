import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { chromeUserAgent } from '../packages/recorder/src/user-agent.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, '.vitepress/dist');
const vitepress = join(root, 'node_modules/vitepress/bin/vitepress.js');
const port = 4173;
const deadLinkPage = join(root, 'docs/zz-dead-link-test.md');

const build = () => spawnSync(process.execPath, [vitepress, 'build'], { cwd: root, encoding: 'utf8' });

let preview: ChildProcess | undefined;
let browser: Browser | undefined;
let deadLinkBuild: ReturnType<typeof build>;

beforeAll(async () => {
  // A failed build empties the output folder, so it runs before the good build.
  writeFileSync(deadLinkPage, '# Dead link\n\n[nowhere](./does-not-exist)\n');
  try {
    deadLinkBuild = build();
  } finally {
    rmSync(deadLinkPage, { force: true });
  }
  const result = build();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  preview = spawn(process.execPath, [vitepress, 'preview', '--port', String(port), '--host', '127.0.0.1'], { cwd: root });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    ready = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.ok, () => false);
    if (!ready) await new Promise((r) => setTimeout(r, 200));
  }
  if (!ready) throw new Error(`vitepress preview did not start on port ${port}`);
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
  preview?.kill();
  rmSync(deadLinkPage, { force: true });
});

const guides = ['docs/guide/what-it-checks', 'docs/guide/first-run', 'docs/guide/reading-results'];

test('builds the landing page as /, the README as /readme, the guides and every published doc', () => {
  for (const page of ['index', 'readme', ...guides, 'docs/cli', 'docs/design', 'docs/shopify-checkout']) {
    expect(existsSync(join(dist, `${page}.html`)), page).toBe(true);
  }
  expect(existsSync(join(dist, 'docs/plan-0.2.html'))).toBe(false);
  expect(existsSync(join(dist, 'docs/release.html'))).toBe(false);
  expect(existsSync(join(dist, 'AGENTS.html'))).toBe(false);
});

test('the build output has no outside fonts or URLs in src, stylesheet href or url()', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/check-docs-dist.ts'), dist], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
});

test('a dead internal link fails the build', () => {
  expect(deadLinkBuild.status).not.toBe(0);
  expect(deadLinkBuild.stdout + deadLinkBuild.stderr).toContain('does-not-exist');
});

test('search finds a word from docs/cli.md', async () => {
  const context = await browser!.newContext({ userAgent: chromeUserAgent(browser!.version()) });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('.VPNavBarSearch button').click();
  await page.locator('#localsearch-input').fill('install-browser');
  const hit = page.locator('#localsearch-list a[href*="/docs/cli"]').first();
  await hit.waitFor();
  expect(await hit.getAttribute('href')).toContain('/docs/cli');
  await context.close();
});

test('the first-run guide copies the get started prompt', async () => {
  const context = await browser!.newContext({ userAgent: chromeUserAgent(browser!.version()) });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://127.0.0.1:${port}` });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/docs/guide/first-run`);
  await page.getByRole('button', { name: 'Copy get started prompt' }).click();
  await expect.poll(() => page.locator('.get-started-status').textContent()).toBe('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('npm i -g pingwright`');
  expect(copied).toContain(await page.locator('.get-started-text').textContent());
  await context.close();
});

test('built pages make no requests to other hosts', async () => {
  const context = await browser!.newContext({ userAgent: chromeUserAgent(browser!.version()) });
  const outside: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url());
  });
  const page = await context.newPage();
  for (const path of ['/', '/readme', ...guides.map((g) => `/${g}`), '/docs/cli', '/docs/design', '/docs/shopify-checkout']) {
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
  }
  await context.close();
  expect(outside).toEqual([]);
});

test('a page with a diagram draws an svg, in light and dark mode, without outside requests', async () => {
  const context = await browser!.newContext({ userAgent: chromeUserAgent(browser!.version()) });
  const outside: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url());
  });
  const page = await context.newPage();
  for (const path of ['/docs/design', ...guides.map((g) => `/${g}`)]) {
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
    await page.locator('.mermaid-svg svg').first().waitFor();
    const drawn = await page.locator('.mermaid-diagram').count();
    expect(await page.locator('.mermaid-svg svg').count(), path).toBe(drawn);
    expect(await page.locator('.mermaid-source').count(), path).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), path).toBe(true);
  }
  const nodeFill = () => page.locator('.mermaid-svg svg .node rect').first().evaluate((el) => getComputedStyle(el).fill);
  const lightFill = await nodeFill();
  await page.locator('.VPSwitchAppearance').first().click();
  await expect.poll(nodeFill).not.toBe(lightFill);
  await context.close();
  expect(outside).toEqual([]);
});

test('diagrams fit a 390 px phone screen without sideways scrolling', async () => {
  const context = await browser!.newContext({
    userAgent: chromeUserAgent(browser!.version()),
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  for (const path of ['/docs/design', ...guides.map((g) => `/${g}`)]) {
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
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
  const context = await browser!.newContext({ userAgent: chromeUserAgent(browser!.version()) });
  const scripts: { url: string; bytes: number }[] = [];
  context.on('response', async (response) => {
    if (response.request().resourceType() !== 'script') return;
    scripts.push({ url: response.url(), bytes: (await response.body()).length });
  });
  const page = await context.newPage();
  const total = () => scripts.reduce((sum, script) => sum + script.bytes, 0);
  const diagramChunk = /mermaid|dagre|cytoscape|flowDiagram/i;

  await page.goto(`http://127.0.0.1:${port}/docs/cli`, { waitUntil: 'networkidle' });
  expect(scripts.filter((script) => diagramChunk.test(script.url))).toEqual([]);
  const withoutDiagram = total();
  expect(withoutDiagram).toBeLessThan(400_000);

  scripts.length = 0;
  await page.goto(`http://127.0.0.1:${port}/docs/guide/first-run`, { waitUntil: 'networkidle' });
  await context.close();
  expect(scripts.some((script) => diagramChunk.test(script.url))).toBe(true);
  expect(total()).toBeGreaterThan(withoutDiagram * 3);
});
