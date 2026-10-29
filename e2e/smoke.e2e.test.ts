import { chromium } from 'playwright';
import { expect, test } from 'vitest';

function chromeUserAgent(browserVersion: string): string {
  const major = browserVersion.split('.')[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

test('Chromium launches with no flags and a normal user agent', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
    const page = await context.newPage();
    await page.goto('about:blank');
    const ua = await page.evaluate(() => navigator.userAgent);
    expect(ua).toContain('Chrome/');
    expect(ua).not.toContain('HeadlessChrome');
  } finally {
    await browser.close();
  }
});
