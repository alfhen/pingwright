import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/datalayer-renamed loads the container with l=myLayer and pushes only to myLayer', async () => {
  const html = await (await fetch(`${site.url}/datalayer-renamed`)).text();
  expect(html).toContain('gtm.js?id=GTM-PWTEST1&amp;l=myLayer');
  expect(html).toContain("window.myLayer.push({ event: 'renamed_one' })");
  expect(html).toContain('/datalayer-renamed-count?n=');
  expect(html).not.toMatch(/window\.dataLayer/);
});

test('the fake gtm.js pushes to the layer that l= names', async () => {
  const script = await (await fetch(`${site.containerUrl}/gtm.js?id=GTM-PWTEST1&l=myLayer`)).text();
  expect(script).toContain('var layer = "myLayer";');
  const plain = await (await fetch(`${site.containerUrl}/gtm.js?id=GTM-PWTEST1`)).text();
  expect(plain).toContain('var layer = "dataLayer";');
});
