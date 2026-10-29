import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromeUserAgent, stubResponse } from '../../src/index.ts';

// Real gtag.js for the fake GA4 ID. Only the script load leaves the machine; every collection request is stubbed.
const PAGE = `<!doctype html><meta charset="utf-8"><title>stub side effects</title>
<script>
window.dataLayer = [];
function gtag() { dataLayer.push(arguments); }
gtag('js', new Date());
gtag('config', 'G-PWTEST0001');
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-PWTEST0001"></script>
<script>
setTimeout(function () {
  var t0 = performance.now();
  gtag('event', 'callback_probe', {
    event_callback: function () { window.callbackAfterMs = performance.now() - t0; },
    event_timeout: 6000,
  });
}, 1500);
</script>`;

type Variant = 'no-content' | 'gif' | 'no-content-after-2s';

let server: Server;
let port: number;
let browser: Browser;

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
  await new Promise((resolve) => {
    server?.close(resolve);
    server?.closeAllConnections();
  });
});

async function probe(variant: Variant) {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  const sent: { method: string; type: string; event: string | null }[] = [];
  context.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname.endsWith('/collect')) {
      sent.push({ method: r.method(), type: r.resourceType(), event: url.searchParams.get('en') ?? new URLSearchParams(r.postData() ?? '').get('en') });
    }
  });
  await context.route(/\/(g|ccm)\/collect/, async (route) => {
    const request = route.request();
    if (variant === 'no-content-after-2s') await new Promise((resolve) => setTimeout(resolve, 2000));
    const stub = stubResponse(
      variant === 'gif' ? { resourceType: 'image', headers: request.headers() } : { resourceType: 'fetch', headers: request.headers() },
    );
    await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  // GA4 sends events other than page_view several seconds after the call.
  await page.waitForTimeout(8000);
  const callbackAfterMs = await page.evaluate(() => (window as unknown as { callbackAfterMs?: number }).callbackAfterMs ?? null);
  await context.close();
  return { sent, callbackAfterMs };
}

test('GA4 does not retry on another transport, and event_callback fires before any response, for every stub', async () => {
  const variants: Variant[] = ['no-content', 'gif', 'no-content-after-2s'];
  const results = await Promise.all(variants.map((v) => probe(v)));
  for (const { sent, callbackAfterMs } of results) {
    expect(sent.map((s) => s.event).sort()).toEqual(['callback_probe', 'page_view']);
    expect(new Set(sent.map((s) => `${s.method} ${s.type}`))).toEqual(new Set(['POST fetch']));
    expect(callbackAfterMs).not.toBeNull();
    expect(callbackAfterMs).toBeLessThan(1500);
  }
});
