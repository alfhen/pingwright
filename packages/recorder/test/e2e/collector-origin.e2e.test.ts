import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { COLLECTOR_ORIGIN } from '../../src/index.ts';

const SHOP_ORIGIN = 'https://shop.pingwright.test';

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

const html = (body: string) => `<!doctype html><meta charset="utf-8"><title>t</title>${body}`;

const post = (path: string) => `fetch('${COLLECTOR_ORIGIN}${path}', { method: 'POST', body: 'x' }).catch(() => {});`;

// A request sent while a sandboxed srcdoc iframe is still loading bypasses context.route
// (ERR_NAME_NOT_RESOLVED). Sending 100 ms after load is usually captured; under load a single send was
// missed, so the script repeats every 300 ms and the tests wait for the first one that arrives.
const sandboxedSrcdoc = (script: string) =>
  `<iframe sandbox="allow-scripts" srcdoc="${`<script>addEventListener('load', () => { const send = () => { ${script} }; setTimeout(send, 100); setInterval(send, 300); });</script>`.replaceAll('"', '&quot;')}"></iframe>`;

const lnaProbe = () =>
  `fetch('http://localhost:${port}/lna-probe', { mode: 'no-cors' })` +
  `.then(() => ${post('/lna-ok').slice(0, -1)}, (e) => fetch('${COLLECTOR_ORIGIN}/lna-error?' + encodeURIComponent(String(e))));`;

const blobWorker = (path: string) =>
  `new Worker(URL.createObjectURL(new Blob([${JSON.stringify(post(path))}], { type: 'text/javascript' })));`;

let server: Server;
let port: number;
let browser: Browser;
let context: BrowserContext | undefined;
let collectorPaths: string[] = [];
let seenRequests: string[] = [];
let serverHits: string[] = [];
let consoleMessages: string[] = [];

function pages(path: string): string | undefined {
  switch (path) {
    case '/fetch':
      return html(`<script>${post('/fetch')}</script>`);
    case '/beacon':
      return html(`<script>navigator.sendBeacon('${COLLECTOR_ORIGIN}/beacon', 'x');</script>`);
    case '/worker':
      return html(`<script>new Worker('/worker.js');</script>`);
    case '/srcdoc':
      return html(sandboxedSrcdoc(post('/srcdoc')));
    case '/cross-site':
      return html(`<iframe sandbox="allow-scripts" src="http://127.0.0.1:${port}/frame"></iframe>`);
    case '/frame':
      return html(`<script>${post('/cross-site')}</script>`);
    case '/lna-control':
      return html(sandboxedSrcdoc(lnaProbe()));
    case '/iframe-worker':
      return html(sandboxedSrcdoc(blobWorker('/iframe-worker')));
    default:
      return undefined;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    serverHits.push(path);
    if (path === '/worker.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(post('/worker'));
      return;
    }
    const body = pages(path);
    res.setHeader('content-type', 'text/html');
    res.statusCode = body === undefined ? 404 : 200;
    res.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function freshContext(): Promise<BrowserContext> {
  await context?.close();
  collectorPaths = [];
  seenRequests = [];
  serverHits = [];
  consoleMessages = [];
  const created = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  created.on('console', (message) => consoleMessages.push(message.text()));
  created.on('request', (request) => {
    if (request.url().startsWith(COLLECTOR_ORIGIN)) seenRequests.push(new URL(request.url()).pathname);
  });
  await created.route(`${COLLECTOR_ORIGIN}/**`, async (route) => {
    collectorPaths.push(new URL(route.request().url()).pathname);
    await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  context = created;
  return created;
}

async function expectCaptured(path: string): Promise<void> {
  await expect.poll(() => collectorPaths, { timeout: 10_000 }).toContain(path);
  await expect.poll(() => seenRequests, { timeout: 10_000 }).toContain(path);
}

const sources: Array<[string, string]> = [
  ['top page fetch', '/fetch'],
  ['navigator.sendBeacon', '/beacon'],
  ['a dedicated worker', '/worker'],
  ['a sandboxed srcdoc iframe', '/srcdoc'],
  ['a sandboxed cross-site iframe', '/cross-site'],
  ['a worker inside a sandboxed iframe', '/iframe-worker'],
];

for (const [label, path] of sources) {
  test(`collector origin captures ${label}`, async () => {
    const ctx = await freshContext();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${port}${path}`);
    await expectCaptured(path);
  });
}

async function openShop(ctx: BrowserContext, script: string): Promise<void> {
  await ctx.route(`${SHOP_ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html(sandboxedSrcdoc(script)) }),
  );
  const page = await ctx.newPage();
  await page.goto(`${SHOP_ORIGIN}/`);
}

test('collector origin captures a sandboxed iframe on a public-looking page', async () => {
  const ctx = await freshContext();
  await openShop(ctx, post('/shop-iframe'));
  await expectCaptured('/shop-iframe');
});

test('a sandboxed iframe on a public-looking page cannot fetch localhost directly, because Chromium blocks public to local', async () => {
  const ctx = await freshContext();
  await openShop(ctx, lnaProbe());
  const outcome = () => collectorPaths.find((p) => p.startsWith('/lna-'));
  await expect.poll(outcome, { timeout: 10_000 }).toBeDefined();
  expect(outcome()).toBe('/lna-error');
  expect(serverHits).not.toContain('/lna-probe');
  expect(consoleMessages.join('\n')).toMatch(/loopback|local network/i);
});

test('control: the same fetch from a sandboxed iframe on a localhost page reaches the server', async () => {
  const ctx = await freshContext();
  const page = await ctx.newPage();
  await page.goto(`http://localhost:${port}/lna-control`);
  await expect.poll(() => collectorPaths.find((p) => p.startsWith('/lna-')), { timeout: 10_000 }).toBe('/lna-ok');
  expect(serverHits).toContain('/lna-probe');
  expect(consoleMessages.join('\n')).not.toMatch(/loopback|local network/i);
});
