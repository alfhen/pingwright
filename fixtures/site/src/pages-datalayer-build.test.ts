import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/datalayer-build serves one page for both builds, with no site.js', async () => {
  const html = await (await fetch(`${site.url}/datalayer-build?build=b`)).text();
  expect(html).toContain("q.get('build') === 'b'");
  expect(html).toContain("ecommerce: { currency: 'USD', value: 25.5 }, value: 10");
  expect(html).toContain("ecommerce: { currency: 'USD' }, value: '10'");
  expect(html).toContain('/datalayer-build?child=1');
  expect(html).not.toContain('site.js');
});

test('build a pushes add_to_cart from the embedded frame and build b from the top frame', async () => {
  const html = await (await fetch(`${site.url}/datalayer-build`)).text();
  const child = html.indexOf("if (q.get('child'))");
  const top = html.indexOf('} else {', child);
  expect(html.slice(child, top)).toContain("event: 'add_to_cart'");
  expect(html.slice(top)).toContain("if (build === 'b') {");
  expect(html.slice(top).match(/event: 'add_to_cart'/g)).toHaveLength(1);
});
