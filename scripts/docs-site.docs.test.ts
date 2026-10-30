import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, '.vitepress/dist');
const vitepress = join(root, 'node_modules/vitepress/bin/vitepress.js');
const port = 4173;
const deadLinkPage = join(root, 'docs/zz-dead-link-test.md');

function osToken(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    default:
      return 'X11; Linux x86_64';
  }
}

function chromeUserAgent(browserVersion: string): string {
  const major = browserVersion.split('.')[0];
  return `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

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

test('builds the README as / and every published doc', () => {
  for (const page of ['index', 'docs/cli', 'docs/design', 'docs/shopify-checkout']) {
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

test('built pages make no requests to other hosts', async () => {
  const context = await browser!.newContext({ userAgent: chromeUserAgent(browser!.version()) });
  const outside: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).hostname !== '127.0.0.1') outside.push(request.url());
  });
  const page = await context.newPage();
  for (const path of ['/', '/docs/cli', '/docs/design', '/docs/shopify-checkout']) {
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'networkidle' });
  }
  await context.close();
  expect(outside).toEqual([]);
});
