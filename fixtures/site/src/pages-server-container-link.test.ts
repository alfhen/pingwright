import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/server-container-link sends GA4 hits to the container from its options, with no site.js or banner', async () => {
  const html = await (await fetch(`${site.url}/server-container-link`)).text();
  expect(html).toContain('window.pwSendLinkHits');
  expect(html).toContain("q.set('ep.event_id', o.eid)");
  expect(html).toContain("q.set('ga4', 'copy')");
  expect(html).toContain("q.set('answer', 'after')");
  expect(html).toContain('/g/collect?');
  expect(html).not.toContain('site.js');
  expect(html).not.toContain('banner.js');
});
