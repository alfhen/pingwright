import { readFileSync } from 'node:fs';
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
const file = (name: string) => readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');

test.each(['terms-required', 'terms-aria-invalid', 'terms-none', 'terms-fields'])('/%s serves its file with the fake email filled in', async (name) => {
  const html = await page(`/${name}`);
  expect(html).toBe(file(name));
  expect(html).toContain('value="pw-fixture@example.com"');
});

test('only terms-required has a required checkbox', async () => {
  expect(await page('/terms-required')).toMatch(/type="checkbox" required/);
  expect(await page('/terms-aria-invalid')).not.toMatch(/required/);
  expect(await page('/terms-none')).not.toContain('checkbox');
});

test('terms-aria-invalid sets aria-invalid on Pay', async () => {
  expect(await page('/terms-aria-invalid')).toContain('setAttribute("aria-invalid", "true")');
});
