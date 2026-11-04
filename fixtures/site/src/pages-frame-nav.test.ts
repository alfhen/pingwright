import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

const page = async (path: string) => (await fetch(site.url + path)).text();

test('/unload-gap-frame-nav embeds the frame document and loads the banner script', async () => {
  const html = await page('/unload-gap-frame-nav');
  expect(html).toContain('<iframe id="pw-nav-frame" src="/unload-gap-frame-nav-frame"');
  expect(html).toContain('/assets/site.js');
});

test('the frame document pushes add_to_cart, navigates to its own URL, then sends a GA4 hit with another name', async () => {
  const html = await page('/unload-gap-frame-nav-frame');
  expect(html).toContain("event: 'add_to_cart'");
  expect(html).toContain('location.href = location.href');
  expect(html).toContain('en=other_frame_ga');
  expect(html).not.toContain('en=add_to_cart');
});
