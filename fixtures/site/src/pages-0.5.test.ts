import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

const page = async (path: string) => (await fetch(site.url + path)).text();

describe('/unload-gap', () => {
  test('with a mode, the iframe src holds the mode and there is no inline script', async () => {
    const html = await page('/unload-gap?mode=x');
    expect(html.match(/<iframe/g)).toHaveLength(1);
    expect(html).toContain('src="/web-pixels@0.0.0-fixture/sandbox/gap/?mode=x"');
    expect(html).not.toMatch(/<script>/);
  });

  test('the mode is encoded', async () => {
    const html = await page('/unload-gap?mode=' + encodeURIComponent('"><b>'));
    expect(html).not.toContain('<b>');
  });

  test('without a mode, the page is the file on disk', async () => {
    expect(await page('/unload-gap')).toBe(readFileSync(new URL('../public/unload-gap.html', import.meta.url), 'utf8'));
  });
});
