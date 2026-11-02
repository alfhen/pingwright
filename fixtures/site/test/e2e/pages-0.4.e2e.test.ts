import { chromium, type Browser } from 'playwright';
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

function chromeUserAgent(browserVersion: string): string {
  return `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split('.')[0]}.0.0.0 Safari/537.36`;
}

function isOffMachine(url: URL): boolean {
  return /^https?:$/.test(url.protocol) && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
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

test('/viewport sends layout_mobile and ua_mobile under 390x844 mobile emulation', async () => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: `${chromeUserAgent(browser.version())} Mobile`,
  });
  try {
    await context.route(
      (url) => isOffMachine(url),
      (route) => route.fulfill({ status: 204 }),
    );
    const page = await context.newPage();
    await page.goto(`${site.url}/viewport`);
    const events = await page.evaluate(() => (window as unknown as { dataLayer: Record<string, unknown>[] }).dataLayer);
    expect(events).toContainEqual({ event: 'layout_mobile' });
    expect(events).toContainEqual({ ua_mobile: true });
  } finally {
    await context.close();
  }
});
