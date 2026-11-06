import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

const page = async (query = '') => (await fetch(`${site.url}/datalayer-wrap${query}`)).text();

describe('/datalayer-wrap', () => {
  test('pushes three events and counts its own pushes', async () => {
    const html = await page();
    for (const event of ['before_loader', 'after_loader_1', 'after_loader_2']) expect(html).toContain(`event: '${event}'`);
    expect(html).toContain('window.pwOwnPushes');
  });

  test('has a wrapper that calls through and one that does not', async () => {
    const html = await page('?wrap=through');
    expect(html).toContain("wrap === 'through'");
    expect(html).toContain("wrap === 'drop'");
    expect(html).toContain('saved.apply(this, arguments)');
    expect(html).toContain("item['gtm.uniqueEventId']");
  });

  test('has a native-assign mode and an identity-guarded install mode', async () => {
    const html = await page('?wrap=native');
    expect(html).toContain('window.dataLayer.push = Array.prototype.push');
    expect(html).toContain("wrap === 'guard'");
    expect(html).toContain('window.dataLayer.push === mine');
  });

  test('the reassign mode loads the fake container and replaces the array', async () => {
    const html = await page('?reassign=1');
    expect(html).toContain('gtm.js?id=GTM-PWTEST1');
    expect(html).toContain('window.dataLayer = []');
  });
});
