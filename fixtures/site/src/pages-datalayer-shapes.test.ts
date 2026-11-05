import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/datalayer-shapes pushes a purchase, odd keys, an odd event name and a consent default, and loads an embedded frame', async () => {
  const html = await (await fetch(`${site.url}/datalayer-shapes`)).text();
  expect(html).toContain("event: 'purchase'");
  expect(html).toContain("'fake.person@example.test'");
  expect(html).toContain("'gid://shopify/Product/1234567890'");
  expect(html).toContain("event: 'fake.person@example.test'");
  expect(html).toContain("window.gtag('consent', 'default'");
  expect(html).toContain('/datalayer-shapes?child=1');
  expect(html).not.toContain('site.js');
});

test('the embedded frame pushes a key that is a fake checkout token', async () => {
  const html = await (await fetch(`${site.url}/datalayer-shapes?child=1`)).text();
  expect(html).toContain("token['deadbeefdeadbeefdeadbeefdeadbeef']");
  expect(html).toContain("event: 'embedded_push'");
});
