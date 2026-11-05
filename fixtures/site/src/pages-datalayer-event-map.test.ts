import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/datalayer-event-map serves both builds on one page, with no site.js', async () => {
  const html = await (await fetch(`${site.url}/datalayer-event-map?build=b`)).text();
  expect(html).toContain("get('build') === 'b'");
  expect(html).not.toContain('site.js');
});

test('build a pushes the Shopify name, a custom event and cart.total; build b the GA4 name, a renamed event and cart.amount', async () => {
  const html = await (await fetch(`${site.url}/datalayer-event-map`)).text();
  const b = html.indexOf("if (build === 'b') {");
  const a = html.indexOf('} else {', b);
  const buildB = html.slice(b, a);
  const buildA = html.slice(a);
  for (const part of ["event: 'purchase'", "event: 'promo_selected'", 'cart: { amount: 5 }']) expect(buildB).toContain(part);
  for (const part of ["event: 'checkout_completed'", "event: 'legacy_promo'", 'cart: { total: 5 }']) expect(buildA).toContain(part);
  expect(buildA).not.toContain("event: 'purchase'");
});
