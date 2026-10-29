import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
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

function chromeUserAgent(browserVersion: string, product = 'Chrome'): string {
  const major = browserVersion.split('.')[0];
  return `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) ${product}/${major}.0.0.0 Safari/537.36`;
}

const collectorOrigin = 'https://collector.pingwright.invalid';

function isCollection(url: URL): boolean {
  if (['localhost', '127.0.0.1'].includes(url.hostname) || url.origin === collectorOrigin) return false;
  const isMeta = /(^|\.)(facebook\.com|facebook\.net)$/.test(url.hostname);
  return (
    /\/(g\/collect|ccm\/collect|pagead\/|td\/)/.test(url.pathname) ||
    (isMeta && /^\/tr\/?$/.test(url.pathname)) ||
    /googleads|doubleclick/.test(url.hostname)
  );
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

interface Watch {
  seen: URL[];
  stubbed: Set<string>;
  collectorBodies: string[];
  bodies: Map<string, string[]>;
}

async function watch(context: BrowserContext): Promise<Watch> {
  const w: Watch = { seen: [], stubbed: new Set(), collectorBodies: [], bodies: new Map() };
  context.on('request', (request) => {
    const url = new URL(request.url());
    w.seen.push(url);
    const body = request.postData();
    if (body) w.bodies.set(request.url(), [...(w.bodies.get(request.url()) ?? []), body]);
  });
  await context.route(
    (url) => isCollection(url),
    (route) => {
      w.stubbed.add(route.request().url());
      return route.fulfill({ status: 204 });
    },
  );
  await context.route(`${collectorOrigin}/**`, (route) => {
    const body = route.request().postData();
    if (body) w.collectorBodies.push(body);
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  return w;
}

function eventNames(url: URL, bodies: string[]): string[] {
  const fromBody = bodies.flatMap((b) => b.split('\n').map((line) => new URLSearchParams(line).get('en')));
  return [url.searchParams.get('en'), ...fromBody].filter((e): e is string => !!e);
}

function ga4Hits(w: Watch): URL[] {
  return [...w.stubbed]
    .map((u) => new URL(u))
    .filter((u) => u.pathname === '/g/collect' && u.searchParams.get('tid') === 'G-PWTEST0001');
}

function ga4Events(w: Watch): string[] {
  return ga4Hits(w).flatMap((u) => eventNames(u, w.bodies.get(u.href) ?? []));
}

function unstubbedCollection(w: Watch): string[] {
  return w.seen.filter((u) => isCollection(u) && !w.stubbed.has(u.href)).map((u) => u.href);
}

test('a visitor accepts, buys, and every tracking request is seen and stubbed', async () => {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  const w = await watch(context);
  const page = await context.newPage();
  await page.goto(`${site.url}/products/fake-tee`);
  await page.locator('#pw-consent-banner').waitFor({ state: 'visible' });
  await page.click('#pw-accept');
  await page.click('#add-to-cart');
  // GA4 sends non-page_view events a few seconds late and drops them on navigation.
  await expect.poll(() => ga4Events(w), { timeout: 15_000 }).toContain('add_to_cart');
  await page.goto(`${site.url}/checkout`);
  await page.fill('#email', 'pat@example.com');
  await page.fill('#first-name', 'Pat');
  await page.fill('#last-name', 'Example');
  await page.fill('#phone', '+1 555 0100');
  await page.fill('#address1', '1 Example Street');
  await page.fill('#city', 'Exampleville');
  await page.fill('#zip', '00000');
  await page.selectOption('#country', 'US');
  await page.click('#continue');
  await page.waitForURL('**/checkout/payment');
  await page.fill('#card-number', '4242 4242 4242 4242');
  await page.fill('#card-expiry', '12/34');
  await page.fill('#card-cvc', '123');
  await page.click('#pay');
  await page.waitForURL('**/thank-you');
  await expect.poll(() => ga4Events(w), { timeout: 15_000 }).toContain('purchase');

  const stubbed = [...w.stubbed].map((u) => new URL(u));
  const ga4 = ga4Hits(w);
  const events = ga4Events(w);
  expect(events).toContain('page_view');
  expect(events).toContain('purchase');
  expect(events).toContain('add_to_cart');

  const meta = stubbed.filter((u) => u.hostname.endsWith('facebook.com') && /^\/tr\/?$/.test(u.pathname));
  const metaEvents = meta.map((u) => u.searchParams.get('ev'));
  expect(metaEvents).toContain('PageView');
  expect(metaEvents).toContain('Purchase');
  expect(metaEvents).toContain('AddToCart');

  const conversion = stubbed.find(
    (u) => u.pathname === '/pagead/conversion/000000001/' && u.searchParams.get('en') === 'conversion',
  );
  expect(conversion).toBeDefined();

  const stape = w.seen.filter((u) => u.origin === site.sgtmUrl && u.pathname === '/pwstape');
  const realPaths = stape.map((u) => Buffer.from(u.searchParams.get('pk') ?? '', 'base64').toString());
  expect(realPaths.some((p) => p.startsWith('/gtag/js?id=G-PWTEST0001'))).toBe(true);
  expect(realPaths.some((p) => p.startsWith('/g/collect?'))).toBe(true);
  const data = realPaths.find((p) => p.startsWith('/data?'));
  expect(data).toBeDefined();
  const dtdc = new URL(data!, 'http://x').searchParams.get('dtdc') ?? '';
  expect(JSON.parse(Buffer.from(dtdc, 'base64').toString())).toMatchObject({ page_hostname: 'localhost' });

  const report = w.collectorBodies.map((b) => JSON.parse(b) as Record<string, string>);
  expect(report.some((r) => r.source === 'fixture-pixel' && r.href?.includes('/web-pixels@'))).toBe(true);
  const sandboxHit = ga4.find((u) => u.hostname === 'region1.google-analytics.com');
  expect(sandboxHit?.searchParams.get('dl')).toContain('/web-pixels@0.0.0-fixture/sandbox/');

  expect(w.seen.some((u) => u.origin === site.thirdPartyUrl && u.pathname === '/unknown-pixel')).toBe(true);
  expect(unstubbedCollection(w)).toEqual([]);
  await context.close();
});

test('a HeadlessChrome user agent never sees the banner', async () => {
  const context = await browser.newContext({
    userAgent: chromeUserAgent(browser.version(), 'HeadlessChrome'),
  });
  const w = await watch(context);
  const page = await context.newPage();
  await page.goto(site.url);
  await new Promise((r) => setTimeout(r, 500));
  expect(await page.locator('#pw-consent-banner').isVisible()).toBe(false);
  const cookies = await context.cookies(site.url);
  expect(cookies.find((c) => c.name === 'pw_consent')?.value).toBe('accept');
  expect(unstubbedCollection(w)).toEqual([]);
  await context.close();
});
