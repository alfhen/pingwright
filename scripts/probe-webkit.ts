// Run by hand: pnpm exec playwright install webkit && node scripts/probe-webkit.ts [webkit|chromium]
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, webkit, type BrowserContext, type BrowserType } from 'playwright';
import { ConsentDriver } from '../packages/consent/src/index.ts';
import { startFixtureSite } from '../fixtures/site/src/index.ts';

const COLLECTOR = 'https://collector.tagreeve.invalid';
const RUNS = 20;
const DAY = 86_400;
const ITP_CAP_DAYS = 7;

const name = process.argv[2] ?? 'webkit';
if (name !== 'webkit' && name !== 'chromium') {
  console.error('Usage: node scripts/probe-webkit.ts [webkit|chromium]');
  process.exit(2);
}
const type: BrowserType = name === 'chromium' ? chromium : webkit;

const isOffMachine = (url: URL) =>
  /^https?:$/.test(url.protocol) && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);

async function stubOffMachine(context: BrowserContext) {
  await context.route(isOffMachine, (route) =>
    route.request().resourceType() === 'script'
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
      : route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }),
  );
}

const post = (path: string) => `fetch('${COLLECTOR}${path}', { method: 'POST', body: 'x' }).catch(() => {});`;
const html = (body: string) => `<!doctype html><meta charset="utf-8"><title>t</title>${body}`;
const srcdoc = (script: string) =>
  `<iframe sandbox="allow-scripts" srcdoc="${`<script>addEventListener('load', () => { const send = () => { ${script} }; setTimeout(send, 100); setInterval(send, 300); });</script>`.replaceAll('"', '&quot;')}"></iframe>`;
const setCookie = `document.cookie = 'pw_probe=1; path=/; max-age=' + 365 * 86400;`;

const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const port = (server.address() as AddressInfo).port;
  const pages: Record<string, string> = {
    '/fetch': html(`<script>${post('/fetch')}</script>`),
    '/beacon': html(`<script>navigator.sendBeacon('${COLLECTOR}/beacon', 'x');</script>`),
    '/worker': html(`<script>new Worker('/worker.js');</script>`),
    '/srcdoc': html(srcdoc(post('/srcdoc'))),
    '/cross-site': html(`<iframe sandbox="allow-scripts" src="http://127.0.0.1:${port}/frame"></iframe>`),
    '/frame': html(`<script>${post('/cross-site')}</script>`),
    '/cookie-top': html(`<script>${setCookie}</script>`),
    '/cookie-frame': html(`<script>${setCookie}</script>`),
    '/cookie-host': html(`<iframe src="http://127.0.0.1:${port}/cookie-frame"></iframe>`),
  };
  if (path === '/worker.js') {
    res.setHeader('content-type', 'text/javascript');
    res.end(post('/worker'));
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.statusCode = pages[path] === undefined ? 404 : 200;
  res.end(pages[path] ?? 'not found');
});

async function routedRuns(launch: () => Promise<BrowserContext>, base: string, path: string, key: string) {
  let routed = 0;
  let seen = 0;
  for (let i = 0; i < RUNS; i++) {
    const context = await launch();
    let hitRoute = false;
    let hitSeen = false;
    context.on('request', (r) => {
      if (r.url().startsWith(`${COLLECTOR}${key}`)) hitSeen = true;
    });
    await context.route(`${COLLECTOR}/**`, (route) => {
      if (route.request().url().startsWith(`${COLLECTOR}${key}`)) hitRoute = true;
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    });
    const page = await context.newPage();
    await page.goto(base + path).catch(() => {});
    for (let t = 0; t < 30 && !(hitRoute && hitSeen); t++) await page.waitForTimeout(100);
    if (hitRoute) routed++;
    if (hitSeen) seen++;
    await context.close();
  }
  return { routed, seen };
}

async function main() {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const site = await startFixtureSite();
  const browser = await type.launch();
  const out: Record<string, unknown> = {};
  out.browser = `${name} ${browser.version()}`;
  out.playwright = (await import('playwright/package.json', { with: { type: 'json' } })).default.version;
  out.platform = `${process.platform} ${process.arch}`;
  const fresh = async () => {
    const context = await browser.newContext(
      name === 'chromium' ? { userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36` } : {},
    );
    await stubOffMachine(context);
    return context;
  };

  const probeContext = await fresh();
  const probePage = await probeContext.newPage();
  await probePage.goto(base + '/fetch');
  const nav = await probePage.evaluate(() => ({ userAgent: navigator.userAgent, webdriver: navigator.webdriver }));
  out.userAgent = nav.userAgent;
  out.webdriver = nav.webdriver;
  out.userAgentMarker = /Headless|Playwright/i.test(nav.userAgent);
  await probeContext.close();

  const sources: [string, string, string][] = [
    ['fetch', '/fetch', '/fetch'],
    ['sendBeacon', '/beacon', '/beacon'],
    ['dedicated worker', '/worker', '/worker'],
    ['sandboxed srcdoc iframe', '/srcdoc', '/srcdoc'],
    ['cross-site iframe', '/cross-site', '/cross-site'],
  ];
  const routing: Record<string, string> = {};
  for (const [label, path, key] of sources) {
    const r = await routedRuns(fresh, base, path, key);
    routing[label] = `routed ${r.routed}/${RUNS}, request event ${r.seen}/${RUNS}`;
  }
  out.collectorRouting = routing;

  const consentContext = await fresh();
  const driver = new ConsentDriver({});
  await driver.install(consentContext);
  const consentPage = await consentContext.newPage();
  await consentPage.goto(site.url);
  const banner = await driver.answer(consentPage, 'accept', 15_000);
  out.autoconsent = { detected: banner.detected, cmp: banner.cmp, result: banner.result, note: banner.note };
  await consentContext.close();

  const itpContext = await fresh();
  const topPage = await itpContext.newPage();
  await topPage.goto(base + '/cookie-top');
  const framePage = await itpContext.newPage();
  await framePage.goto(base + '/cookie-host');
  await framePage.waitForTimeout(500);
  const cookies = await itpContext.cookies();
  const days = (c: { expires: number }) => (c.expires > 0 ? Math.round((c.expires - Date.now() / 1000) / DAY) : null);
  const top = cookies.find((c) => c.name === 'pw_probe' && c.domain === 'localhost');
  const frame = cookies.find((c) => c.name === 'pw_probe' && c.domain === '127.0.0.1');
  out.cookieTop = top ? { expiresInDays: days(top) } : 'not stored';
  out.cookieCrossSiteFrame = frame ? { expiresInDays: days(frame) } : 'not stored';
  const topDays = top ? days(top) : null;
  out.itpCapsScriptCookies = topDays !== null && topDays <= ITP_CAP_DAYS;
  await itpContext.close();

  const hostContext = await fresh();
  await hostContext.route('https://shop.tagreeve.test/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html(`<script>${setCookie}</script>`) }),
  );
  const hostPage = await hostContext.newPage();
  await hostPage.goto('https://shop.tagreeve.test/');
  const hostCookie = (await hostContext.cookies()).find((c) => c.name === 'pw_probe');
  out.cookieNonLoopbackHost = hostCookie ? { expiresInDays: days(hostCookie) } : 'not stored';
  const hostDays = hostCookie ? days(hostCookie) : null;
  out.itpCapsScriptCookies =
    topDays === null && hostDays === null ? 'unknown (no cookie stored)' : out.itpCapsScriptCookies || (hostDays !== null && hostDays <= ITP_CAP_DAYS);
  await hostContext.close();

  await browser.close();
  await site.close();
  server.close();
  console.log(JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.log(JSON.stringify({ browser: name, error: String(error?.message ?? error).split('\n')[0] }, null, 2));
  server.close();
  process.exit(1);
});
