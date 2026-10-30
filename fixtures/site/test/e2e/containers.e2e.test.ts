import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { fakeWorkspace } from '../../src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../../src/index.ts';

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
  return `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split('.')[0]}.0.0.0 Safari/537.36`;
}

const workspaceQuery = new URLSearchParams(fakeWorkspace).toString();

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function isOffMachine(url: URL): boolean {
  return /^https?:$/.test(url.protocol) && !isLoopback(url);
}

function isAllowedScriptLoad(url: URL): boolean {
  if (url.hostname === 'www.googletagmanager.com') return url.pathname === '/gtag/js';
  if (url.hostname === 'connect.facebook.net') {
    return /\/fbevents\.js$/.test(url.pathname) || url.pathname.startsWith('/signals/config/');
  }
  return false;
}

let site: FixtureSite;
let browser: Browser;

beforeAll(async () => {
  site = await startFixtureSite();
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

interface Run {
  context: BrowserContext;
  page: Page;
  seen: { url: URL; referer: string | undefined; body: string | null }[];
  stubbed: URL[];
  gtmStatus: number[];
}

// Routes www.googletagmanager.com/gtm.js to the fixture container host, optionally with preview parameters.
async function start(workspace: boolean): Promise<Run> {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  const run: Run = { context, page: await context.newPage(), seen: [], stubbed: [], gtmStatus: [] };
  context.on('request', (request) => {
    run.seen.push({
      url: new URL(request.url()),
      referer: request.headers()['referer'],
      body: request.postData(),
    });
  });
  await context.route(
    (url) => isOffMachine(url),
    (route) => {
      const url = new URL(route.request().url());
      if (isAllowedScriptLoad(url)) return route.continue();
      run.stubbed.push(url);
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    },
  );
  await context.route('https://www.googletagmanager.com/gtm.js*', async (route) => {
    const url = new URL(route.request().url());
    const target = new URL(`${site.containerUrl}/gtm.js${url.search}`);
    if (workspace) for (const [k, v] of Object.entries(fakeWorkspace)) target.searchParams.set(k, v);
    const response = await route.fetch({ url: target.href });
    run.gtmStatus.push(response.status());
    await route.fulfill({ response });
  });
  return run;
}

function ga4Events(run: Run): string[] {
  return run.stubbed
    .filter((u) => u.pathname === '/g/collect' && u.searchParams.get('tid') === 'G-PWTEST0001')
    .flatMap((u) => {
      const bodies = run.seen.filter((s) => s.url.href === u.href).map((s) => s.body ?? '');
      return [u.searchParams.get('en'), ...bodies.flatMap((b) => b.split('\n').map((l) => new URLSearchParams(l).get('en')))];
    })
    .filter((e): e is string => !!e);
}

function pageViewGcs(run: Run): string | null {
  const hit = run.stubbed.find(
    (u) => u.pathname === '/g/collect' && u.searchParams.get('en') === 'page_view' && u.searchParams.has('gcs'),
  );
  return hit?.searchParams.get('gcs') ?? null;
}

function metaEvents(run: Run): string[] {
  return run.stubbed
    .filter((u) => u.hostname.endsWith('facebook.com') && /^\/tr\/?$/.test(u.pathname))
    .map((u) => u.searchParams.get('ev') ?? '');
}

const published = { ga4: ['container_event'], meta: ['PageView', 'ViewContent', 'AddToCart'] };

async function settle(run: Run, expected: { ga4: string[]; meta: string[] }): Promise<void> {
  await expect.poll(() => ga4Events(run), { timeout: 20_000 }).toEqual(expect.arrayContaining(['page_view', ...expected.ga4]));
  await expect.poll(() => metaEvents(run), { timeout: 20_000 }).toEqual(expect.arrayContaining(expected.meta));
}

test('the published build, direct: its hits, and a container-level denied default', async () => {
  const run = await start(false);
  await run.page.goto(`${site.url}/container/direct`);
  await settle(run, published);
  expect(run.gtmStatus).toEqual([200]);
  expect(ga4Events(run)).not.toContain('workspace_only');
  expect(await run.page.evaluate(() => (window as unknown as { pwContainer: { build: string } }).pwContainer.build)).toBe(
    'published',
  );
  // ad_storage denied and analytics_storage denied
  expect(pageViewGcs(run)).toBe('G100');
  await run.context.close();
});

test('the workspace build, direct: one more GA4 event, no AddToCart, and a different gcs', async () => {
  const run = await start(true);
  await run.page.goto(`${site.url}/container/direct`);
  await settle(run, { ga4: ['container_event', 'workspace_only'], meta: ['PageView', 'ViewContent'] });
  expect(metaEvents(run)).not.toContain('AddToCart');
  // ad_storage granted, analytics_storage denied (G1, ad, analytics)
  expect(pageViewGcs(run)).toBe('G110');
  await run.context.close();
});

test('the Stape-style loader reaches the same published build through a disguised request', async () => {
  const run = await start(false);
  await run.page.goto(`${site.url}/container/stape`);
  await settle(run, published);
  const loader = run.seen.find((s) => s.url.origin === site.sgtmUrl && s.url.pathname === '/pwstape');
  expect(Buffer.from(loader?.url.searchParams.get('pk') ?? '', 'base64').toString()).toBe('/gtm.js?id=GTM-PWTEST1');
  expect(run.gtmStatus).toEqual([]);
  await run.context.close();
});

test('the same loader inside a sandboxed iframe sends the published hits', async () => {
  const run = await start(false);
  await run.page.goto(`${site.url}/container/sandbox`);
  await settle(run, published);
  const hit = run.stubbed.find((u) => u.pathname === '/g/collect' && u.searchParams.get('en') === 'page_view');
  expect(hit?.searchParams.get('dl')).toContain('/web-pixels@');
  await run.context.close();
});

test('a container with no version is 404 and the page still loads', async () => {
  const run = await start(false);
  await run.page.goto(`${site.url}/container/noversion`);
  await expect.poll(() => run.gtmStatus).toEqual([404]);
  expect(await run.page.evaluate(() => 'pwContainer' in window)).toBe(false);
  await run.context.close();
});

test('the workspace build is served only for the fake parameters', async () => {
  const base = `${site.containerUrl}/gtm.js?id=GTM-PWTEST1`;
  const context = await browser.newContext();
  site.receivedGtmAuth.length = 0;
  const ok = await context.request.get(`${base}&${workspaceQuery}`);
  expect(ok.status()).toBe(200);
  expect(await ok.text()).toContain('workspace build');
  expect((await context.request.get(`${base}&build=workspace`)).status()).toBe(404);
  expect((await context.request.get(`${base}&gtm_auth=wrong&gtm_preview=env-99&gtm_cookies_win=x`)).status()).toBe(404);
  expect(await (await context.request.get(base)).text()).toContain('published build');
  expect(site.receivedGtmAuth).toEqual([fakeWorkspace.gtm_auth, 'wrong']);
  await context.close();
});

test('the workspace build echoes its gtm_auth in a URL, a beacon body, a Referer and Stape-style hits', async () => {
  const run = await start(true);
  await run.page.goto(`${site.url}/container/echo`);
  const echoed = () => run.seen.filter((s) => s.url.origin === site.thirdPartyUrl);
  const stape = () => run.seen.filter((s) => s.url.origin === site.sgtmUrl && s.url.pathname === '/pwstape');
  const real = (pk: string | null) => Buffer.from(pk ?? '', 'base64').toString();
  await expect.poll(() => echoed().map((s) => s.url.pathname)).toEqual(
    expect.arrayContaining(['/gtm-echo.gif', '/gtm-echo', '/gtm-referer.gif']),
  );
  await expect.poll(() => stape().map((s) => real(s.url.searchParams.get('pk')).split('?')[0])).toEqual(
    expect.arrayContaining(['/g/collect', '/data']),
  );
  expect(echoed().find((s) => s.url.pathname === '/gtm-echo.gif')?.url.search).toContain(fakeWorkspace.gtm_auth);
  expect(echoed().find((s) => s.url.pathname === '/gtm-echo')?.body).toContain(fakeWorkspace.gtm_auth);
  expect(echoed().find((s) => s.url.pathname === '/gtm-referer.gif')?.referer).toContain(fakeWorkspace.gtm_auth);
  const paths = stape().map((s) => new URL(real(s.url.searchParams.get('pk')), 'http://x'));
  const collect = paths.find((u) => u.pathname === '/g/collect');
  expect(collect?.searchParams.get('dl')).toContain(fakeWorkspace.gtm_auth);
  const data = paths.find((u) => u.pathname === '/data');
  const dtdc = JSON.parse(Buffer.from(data?.searchParams.get('dtdc') ?? '', 'base64').toString());
  expect(dtdc.page_location).toContain(fakeWorkspace.gtm_auth);
  await run.context.close();
});

test('the published build on the same page URL echoes nothing', async () => {
  const run = await start(false);
  await run.page.goto(`${site.url}/container/echo?gtm_auth=${fakeWorkspace.gtm_auth}`);
  await settle(run, published);
  expect(run.seen.filter((s) => s.url.pathname === '/gtm-referer.gif' || s.url.pathname.startsWith('/gtm-echo'))).toEqual([]);
  expect(run.seen.filter((s) => s.url.origin === site.sgtmUrl)).toEqual([]);
  await run.context.close();
});
