import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

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

test('Chromium launches with no flags and never identifies as HeadlessChrome', async () => {
  const seenClientHints: string[] = [];
  const server = createServer((req, res) => {
    seenClientHints.push(String(req.headers['sec-ch-ua'] ?? ''));
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>smoke</title>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const { ua, brands } = await page.evaluate(() => ({
      ua: navigator.userAgent,
      brands: JSON.stringify(
        (navigator as Navigator & { userAgentData?: { brands: unknown } }).userAgentData?.brands,
      ),
    }));
    const hints = seenClientHints.join(' ');
    expect(ua).toContain('Chrome/');
    expect(ua).not.toContain('HeadlessChrome');
    expect(brands).toContain('Chromium');
    expect(brands).not.toContain('HeadlessChrome');
    expect(hints).toContain('Chromium');
    expect(hints).not.toContain('HeadlessChrome');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
