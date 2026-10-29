import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromeUserAgent, stubResponse } from '../../src/index.ts';

// Real gtag.js for the fake GA4 and Ads IDs, with consent denied by the fixture's default. Only script and
// library loads leave the machine: every collection request is answered by a route in this file.
const COLLECTION = /\/(?:g|ccm)\/collect|\/pagead\/|facebook\.com\/tr/;

type Variant = 'no-content' | 'gif' | 'no-content-after-2s' | 'abort';

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

interface Sent {
  path: string;
  method: string;
  type: string;
  event: string | null;
  at: number;
}

async function probe(variant: Variant) {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  const sent: Sent[] = [];
  const answered: { event: string | null; at: number }[] = [];
  let collectionRequests = 0;
  let routedCollection = 0;
  context.on('request', (r) => {
    if (!COLLECTION.test(r.url())) return;
    collectionRequests++;
    const url = new URL(r.url());
    const event = url.searchParams.get('en') ?? new URLSearchParams(r.postData() ?? '').get('en');
    if (/^\/(?:g|ccm)\/collect$/.test(url.pathname)) sent.push({ path: url.pathname, method: r.method(), type: r.resourceType(), event, at: Date.now() });
  });
  await context.route(COLLECTION, async (route) => {
    routedCollection++;
    const request = route.request();
    const url = new URL(request.url());
    const event = url.searchParams.get('en') ?? new URLSearchParams(request.postData() ?? '').get('en');
    if (variant === 'no-content-after-2s') await new Promise((resolve) => setTimeout(resolve, 2000));
    if (variant === 'abort') {
      answered.push({ event, at: Date.now() });
      await route.abort('failed');
      return;
    }
    const stub = stubResponse(
      variant === 'gif' ? { resourceType: 'image', headers: request.headers() } : { resourceType: 'fetch', headers: request.headers() },
    );
    answered.push({ event, at: Date.now() });
    await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
  });
  const page = await context.newPage();
  await page.goto(`${site.url}/products/fake-tee`);
  await page.waitForTimeout(1500);
  const called = await page.evaluate(() => {
    const w = window as unknown as { gtag: (...a: unknown[]) => void; callbackAt?: number };
    const calledAt = Date.now();
    w.gtag('event', 'callback_probe', {
      event_callback: () => {
        w.callbackAt = Date.now();
      },
      event_timeout: 6000,
    });
    return calledAt;
  });
  // GA4 sends events other than page_view several seconds after the call.
  await page.waitForTimeout(8000);
  const callbackAt = await page.evaluate(() => (window as unknown as { callbackAt?: number }).callbackAt ?? null);
  await context.close();
  return { sent, answered, called, callbackAt, collectionRequests, routedCollection };
}

test('GA4 does not retry on another transport, and event_callback does not wait for any response, for every stub', async () => {
  const variants: Variant[] = ['no-content', 'gif', 'no-content-after-2s', 'abort'];
  const results = await Promise.all(variants.map((v) => probe(v)));
  results.forEach(({ sent, answered, called, callbackAt, collectionRequests, routedCollection }, i) => {
    const variant = variants[i]!;
    expect(routedCollection, `${variant}: every collection request was routed`).toBe(collectionRequests);
    expect(sent.map((s) => s.event), variant).toContain('callback_probe');
    expect(new Set(sent.filter((s) => s.path === '/g/collect').map((s) => `${s.method} ${s.type}`)), variant).toEqual(new Set(['POST fetch']));
    expect(callbackAt, variant).not.toBeNull();
    const probeHit = sent.find((s) => s.event === 'callback_probe')!;
    const probeAnswer = answered.find((a) => a.event === 'callback_probe')!;
    expect(probeHit.at, `${variant}: the hit is sent after the call`).toBeGreaterThanOrEqual(called);
    expect(callbackAt! - called, variant).toBeLessThan(1500);
    if (variant === 'no-content-after-2s') expect(callbackAt!, 'callback before the delayed answer').toBeLessThan(probeAnswer.at);
  });
});
