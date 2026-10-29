import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromeUserAgent, stubResponse } from '../../src/index.ts';

// Real gtag.js for the fake GA4 and Ads IDs, with consent denied by the fixture's default. Only script and
// library loads leave the machine: every collection request is answered by a route in this file.
const COLLECTION = /\/(?:g|ccm)\/collect|\/pagead\/|facebook\.com\/tr/;
const FIXTURE_PIXEL_CID = '3333333333.4444444444';
const EVENT = 'view_item';

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
  vendor: 'ga4' | 'ads' | 'other';
  path: string;
  method: string;
  type: string;
  event: string | null;
  at: number;
}

function vendorOf(url: URL): Sent['vendor'] {
  if (url.pathname === '/g/collect' && url.searchParams.get('cid') !== FIXTURE_PIXEL_CID) return 'ga4';
  if (url.pathname === '/ccm/collect' || url.pathname.startsWith('/pagead/')) return 'ads';
  return 'other';
}

function eventsOf(url: URL, postData: string | null): (string | null)[] {
  const lines = (postData ?? '').split('\n').filter((line) => line !== '');
  if (lines.length === 0) return [url.searchParams.get('en')];
  return lines.map((line) => new URLSearchParams(line).get('en') ?? url.searchParams.get('en'));
}

async function probe(variant: Variant) {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  // The site's own view_item call gets a callback, so the test measures gtag's callback for a real GA4 hit.
  await context.addInitScript((event) => {
    const w = window as unknown as Record<string, unknown>;
    let wrapped: unknown;
    Object.defineProperty(window, 'gtag', {
      configurable: true,
      get: () => wrapped,
      set: (original: (...a: unknown[]) => void) => {
        wrapped = function (this: unknown, ...a: unknown[]) {
          if (a[0] === 'event' && a[1] === event) {
            w.__calledAt = Date.now();
            a[2] = { ...(a[2] as object), event_callback: () => (w.__callbackAt = Date.now()), event_timeout: 6000 };
          }
          return original.apply(this, a);
        };
      },
    });
  }, EVENT);
  const sent: Sent[] = [];
  const answered: { vendor: Sent['vendor']; event: string | null; at: number }[] = [];
  let collectionRequests = 0;
  let routedCollection = 0;
  context.on('request', (r) => {
    if (!COLLECTION.test(r.url())) return;
    collectionRequests++;
    const url = new URL(r.url());
    for (const event of eventsOf(url, r.postData())) {
      sent.push({ vendor: vendorOf(url), path: url.pathname, method: r.method(), type: r.resourceType(), event, at: Date.now() });
    }
  });
  await context.route(COLLECTION, async (route) => {
    routedCollection++;
    const request = route.request();
    const url = new URL(request.url());
    if (variant === 'no-content-after-2s') await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const event of eventsOf(url, request.postData())) answered.push({ vendor: vendorOf(url), event, at: Date.now() });
    if (variant === 'abort') {
      await route.abort('failed');
      return;
    }
    const stub = stubResponse(
      variant === 'gif' ? { resourceType: 'image', headers: request.headers() } : { resourceType: 'fetch', headers: request.headers() },
    );
    await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
  });
  const page = await context.newPage();
  await page.goto(`${site.url}/products/fake-tee`);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => (window as unknown as { __callbackAt?: number }).__callbackAt !== undefined);
    if (done && sent.some((s) => s.vendor === 'ga4' && s.event === EVENT)) break;
    await page.waitForTimeout(100);
  }
  // Time for a retry on another transport to show up.
  await page.waitForTimeout(2500);
  const times = await page.evaluate(() => {
    const w = window as unknown as { __calledAt?: number; __callbackAt?: number };
    return { calledAt: w.__calledAt ?? null, callbackAt: w.__callbackAt ?? null };
  });
  await context.close();
  return { sent, answered, ...times, collectionRequests, routedCollection };
}

test('GA4 sends each event once as POST fetch and event_callback does not wait for the answer, for every stub', async () => {
  const variants: Variant[] = ['no-content', 'gif', 'no-content-after-2s', 'abort'];
  const results = await Promise.all(variants.map((v) => probe(v)));
  results.forEach(({ sent, answered, calledAt, callbackAt, collectionRequests, routedCollection }, i) => {
    const variant = variants[i]!;
    expect(routedCollection, `${variant}: every collection request was routed`).toBe(collectionRequests);

    const ga4 = sent.filter((s) => s.vendor === 'ga4');
    const ga4Events = ga4.map((s) => s.event).sort();
    if (variant === 'abort') {
      expect([...new Set(ga4Events)], 'abort: GA4 sent both events, possibly retried').toEqual(['page_view', EVENT]);
      expect(new Set(ga4.map((s) => `${s.method} ${s.type}`)).has('POST fetch'), 'abort: GA4 first sent as POST fetch').toBe(true);
    } else {
      expect(ga4Events, `${variant}: GA4 sent each event once`).toEqual(['page_view', EVENT]);
      expect(new Set(ga4.map((s) => `${s.method} ${s.type}`)), `${variant}: GA4 transport`).toEqual(new Set(['POST fetch']));
    }

    const other = sent.filter((s) => s.vendor === 'other');
    expect(
      other.every((s) => s.path === '/tr/' || s.path === '/g/collect'),
      `${variant}: only Meta /tr/ and the fixture pixel's own /g/collect hit fall outside GA4 and Ads, got ${JSON.stringify(other.map((s) => s.path))}`,
    ).toBe(true);

    const ads = sent.filter((s) => s.vendor === 'ads');
    const adsTransports = new Set(ads.map((s) => `${s.method} ${s.type}`));
    if (variant === 'abort') expect(adsTransports, 'an aborted Ads hit is retried as an image').toEqual(new Set(['POST fetch', 'GET image']));
    else expect(adsTransports, `${variant}: Ads transport`).toEqual(new Set(['POST fetch']));

    expect(calledAt, variant).not.toBeNull();
    expect(callbackAt, variant).not.toBeNull();
    const hit = ga4.find((s) => s.event === EVENT)!;
    const answer = answered.find((a) => a.vendor === 'ga4' && a.event === EVENT)!;
    expect(hit.at, `${variant}: the hit is sent after the call`).toBeGreaterThanOrEqual(calledAt!);
    expect(callbackAt! - hit.at, `${variant}: callback within 1.5 s of the hit`).toBeLessThan(1500);
    if (variant === 'no-content-after-2s') expect(callbackAt!, 'callback before the delayed answer').toBeLessThan(answer.at);
  });
});
