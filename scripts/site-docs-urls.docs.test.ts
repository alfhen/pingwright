import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { dist, docsUrl, newDocsContext } from './docs-test-helpers.ts';

let browser: Browser | undefined;
let pages: Server | undefined;
let pagesUrl = '';

const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

/**
 * Serves site/dist the way GitHub Pages does, as checked against tagreeve.dev: `/docs/cli` serves
 * docs/cli.html, a folder without a trailing slash redirects to one (`/docs/guide` to `/docs/guide/`),
 * and anything else, `/docs/cli/` included, gets 404.html with status 404. `astro preview` answers
 * `/docs/cli/` with its own error page instead, so it cannot show what the live site does.
 */
function githubPagesLike(): Server {
  return createServer((request, response) => {
    const path = decodeURIComponent(request.url!.split('?')[0]!);
    const file = join(dist, path);
    const send = (status: number, target: string) => {
      response.writeHead(status, { 'content-type': types[extname(target)] ?? 'application/octet-stream' });
      response.end(readFileSync(target));
    };
    if (!file.startsWith(dist)) return send(404, join(dist, '404.html'));
    if (existsSync(file) && statSync(file).isFile()) return send(200, file);
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith('/')) {
        response.writeHead(301, { location: `${path}/` });
        return response.end();
      }
      if (existsSync(join(file, 'index.html'))) return send(200, join(file, 'index.html'));
    } else if (!path.endsWith('/') && existsSync(`${file}.html`)) {
      return send(200, `${file}.html`);
    }
    send(404, join(dist, '404.html'));
  });
}

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chromium' });
  pages = githubPagesLike();
  await new Promise<void>((resolve) => pages!.listen(0, '127.0.0.1', resolve));
  pagesUrl = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => pages?.close(resolve));
});

function builtPages(dir = dist): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'pagefind' || entry.name === '_astro' ? [] : builtPages(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

test('/readme has one h1, the lockup, and no empty title band above it', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  const headerBottom = async () => (await page.locator('header.header').boundingBox())!.height;

  await page.goto(`${docsUrl}/docs/cli`);
  const pathLabelGap = (await page.locator('.docs-path').boundingBox())!.y - (await headerBottom());

  await page.goto(`${docsUrl}/readme`);
  expect(await page.locator('h1').count()).toBe(1);
  const lockup = page.locator('.sl-markdown-content h1');
  expect(await lockup.locator('img').count()).toBeGreaterThan(0);
  expect(await page.locator('#_top').count()).toBe(1);
  const band = (await page.locator('.content-panel').first().boundingBox())!;
  expect(band.height).toBe(0);
  const lockupGap = (await lockup.boundingBox())!.y - (await headerBottom());
  expect(lockupGap).toBe(pathLabelGap);
  await context.close();
});

test('the 404 page offers only what is on it, and its links work', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  const response = await page.goto(`${pagesUrl}/does-not-exist`);
  expect(response!.status()).toBe(404);
  expect(await page.locator('h1').textContent()).toBe('Page not found');
  const text = page.locator('.not-found-text');
  expect((await text.textContent())!.replace(/\s+/g, ' ').trim()).toBe(
    'There is no page at this address. Check the URL, or start from the guides or the home page.',
  );
  expect(await page.locator('main').textContent()).not.toMatch(/search bar/i);
  const links = await text.locator('a').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')!));
  expect(links).toEqual(['/docs/guide/what-it-checks', '/']);
  for (const href of links) {
    expect((await page.request.get(`${pagesUrl}${href}`)).status(), href).toBe(200);
  }
  await context.close();
});

test('search results link to clean URLs, also after the results change', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  await page.goto(`${docsUrl}/docs/guide/first-run`);
  await page.locator('button[data-open-modal]').click();
  const input = page.locator('.pagefind-ui__search-input');
  const resultLinks = () => page.locator('#starlight__search a[href]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute('href')!));

  for (const query of ['install-browser', 'consent epoch']) {
    await input.fill(query);
    await page.locator('.pagefind-ui__result-link').first().waitFor();
    await expect.poll(async () => (await resultLinks()).length).toBeGreaterThan(0);
    const hrefs = await resultLinks();
    expect(hrefs.filter((href) => href.includes('.html')), query).toEqual([]);
  }

  await input.fill('install-browser');
  const hit = page.locator('.pagefind-ui__result-link[href^="/docs/cli"]').first();
  await hit.waitFor();
  expect(await hit.getAttribute('href')).toMatch(/^\/docs\/cli(#|$)/);
  await hit.click();
  await page.waitForURL(/\/docs\/cli(#|$)/);
  await context.close();
});

test('the sidebar, prev and next links, canonical link and og:url of every page use clean URLs', () => {
  const htmlLink = /\s(?:href|content)="(?:https:\/\/tagreeve\.dev)?\/[^"#?]*\.html(?:[#?][^"]*)?"/g;
  for (const file of builtPages()) {
    expect(readFileSync(file, 'utf8').match(htmlLink) ?? [], file).toEqual([]);
  }
  const cli = readFileSync(join(dist, 'docs/cli.html'), 'utf8');
  expect(cli).toContain('<link rel="canonical" href="https://tagreeve.dev/docs/cli"');
  expect(cli).toContain('<meta property="og:url" content="https://tagreeve.dev/docs/cli"');
  expect(cli).toMatch(/<a href="\/docs\/cli" aria-current="page"/);
  expect(cli).toMatch(/<a href="\/readme" rel="prev"/);
});

test('/docs/cli/ loads the CLI page on GitHub Pages, and /docs/cli still loads without a redirect', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();

  const direct = await page.goto(`${pagesUrl}/docs/cli`);
  expect(direct!.status()).toBe(200);
  expect(direct!.request().redirectedFrom()).toBeNull();
  expect(await page.locator('h1').textContent()).toBe('CLI');

  await page.goto(`${pagesUrl}/docs/cli/?a=1#install`);
  await page.waitForURL(`${pagesUrl}/docs/cli?a=1#install`);
  expect(await page.locator('h1').textContent()).toBe('CLI');

  await page.goto(`${pagesUrl}/docs/guide/first-run/`);
  await page.waitForURL(`${pagesUrl}/docs/guide/first-run`);
  expect(await page.locator('h1').textContent()).toBe('Your first run');
  await context.close();
});

test('a trailing slash on a path that is not a page stays on the 404 page instead of looping', async () => {
  const context = await newDocsContext(browser!);
  const page = await context.newPage();
  const seen: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) seen.push(frame.url());
  });
  for (const path of ['/docs/guide/', '/does-not-exist/', '//example.com/']) {
    seen.length = 0;
    await page.goto(`${pagesUrl}${path}`);
    await page.waitForTimeout(300);
    expect(await page.locator('h1').textContent(), path).toBe('Page not found');
    expect(seen, path).toEqual([`${pagesUrl}${path}`]);
  }
  await context.close();
});
