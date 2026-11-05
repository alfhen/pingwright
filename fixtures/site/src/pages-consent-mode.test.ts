import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/consent-mode-hits sends one GA4 hit that carries the gcs and gcd from the query', async () => {
  const html = await (await fetch(`${site.url}/consent-mode-hits?gcd=13r3r3l3r5`)).text();
  expect(html).toContain('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001');
  expect(html).toContain("q.get('gcs')");
  expect(html).toContain("q.get('gcd')");
});

test('/consent-mode-hits pushes a consent default only with push=default', async () => {
  const html = await (await fetch(`${site.url}/consent-mode-hits`)).text();
  expect(html).toContain("q.get('push') === 'default'");
  expect(html).toContain("window.gtag('consent', 'default'");
  expect(html).not.toContain('banner.js');
});
