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

describe('0.4 pages', () => {
  test.each(['/handoff/until', '/thank-you-late', '/checkout/test-payment', '/viewport', '/unload-gap?mode=custom', '/unload-gap?mode=close'])(
    '%s answers 200 html',
    async (path) => {
      const res = await fetch(site.url + path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
    },
  );

  test('/handoff/until links to /thank-you-late with #pw-to-thank-you', async () => {
    const html = await page('/handoff/until');
    expect(html).toContain('id="pw-to-thank-you"');
    expect(html).toContain('href="/thank-you-late"');
  });

  test('/thank-you-late sends a GA4 purchase 2 s after load', async () => {
    const html = await page('/thank-you-late');
    expect(html).toContain('en=purchase');
    expect(html).toContain('G-PWTEST0001');
    expect(html).toMatch(/\}, 2000\);/);
  });

  test('/viewport branches on width 600 and on a Mobile user agent', async () => {
    const html = await page('/viewport');
    expect(html).toContain('window.innerWidth < 600');
    expect(html).toContain('layout_mobile');
    expect(html).toContain('layout_desktop');
    expect(html).toContain("indexOf('Mobile')");
    expect(html).toContain('ua_mobile: true');
  });
});

describe('/checkout/test-payment', () => {
  test('frames a page from a different origin than its own', async () => {
    const config = await (await fetch(`${site.url}/fixture-config.js`)).text();
    expect(config).toContain(JSON.stringify(site.paymentFrameUrl));
    expect(new URL(site.paymentFrameUrl).origin).not.toBe(new URL(site.url).origin);
    expect(new URL(site.paymentFrameUrl).hostname).toBe('127.0.0.1');
    expect(await page('/checkout/test-payment')).toContain("window.__PW_FIXTURE.paymentFrameUrl + '/card-frame'");
  });

  test('has the marker, the top-page card input and #pay', async () => {
    const html = await page('/checkout/test-payment');
    expect(html).toContain('id="pw-test-mode"');
    expect(html).toContain('id="card-number"');
    expect(html).toContain('id="pay"');
  });

  test('?marker=off leaves out #pw-test-mode', async () => {
    const html = await page('/checkout/test-payment?marker=off');
    expect(html).not.toContain('pw-test-mode');
    expect(html).toContain('id="card-number"');
  });

  test('the card frame has the three cc fields', async () => {
    const res = await fetch(`${site.paymentFrameUrl}/card-frame`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const id of ['cc-number', 'cc-exp', 'cc-csc']) expect(html).toContain(`id="${id}"`);
    for (const ac of ['cc-number', 'cc-exp', 'cc-csc']) expect(html).toContain(`autocomplete="${ac}"`);
  });

  test('a submit to the card server adds the card number to cardSubmits', async () => {
    const before = site.cardSubmits.length;
    const res = await fetch(`${site.paymentFrameUrl}/card-submit`, { method: 'POST', body: '4242424242424242' });
    expect(res.status).toBe(204);
    expect(site.cardSubmits.slice(before)).toEqual(['4242424242424242']);
  });

  test('the card server answers nothing else', async () => {
    expect((await fetch(`${site.paymentFrameUrl}/`)).status).toBe(404);
    expect((await fetch(`${site.paymentFrameUrl}/card-submit`)).status).toBe(404);
    expect((await fetch(`${site.paymentFrameUrl}/thank-you`)).status).toBe(404);
  });
});

describe('/unload-gap modes', () => {
  test('the page passes ?mode to the frame and leaves the frame URL alone without it', async () => {
    const html = await page('/unload-gap');
    expect(html).toContain('src="/web-pixels@0.0.0-fixture/sandbox/gap/"');
    expect(html).toContain("get('mode')");
  });

  test('the frame script handles custom and close, and the default hits are unchanged', async () => {
    const js = await page('/assets/gap-pixel.js');
    expect(js).toContain("mode === 'custom'");
    expect(js).toContain('custom_add_ga');
    expect(js).toContain("send('/data', 'en=custom_add')");
    expect(js).toContain("mode === 'close'");
    expect(js).toContain("event: 'add_to_cart'");
    expect(js).toContain("send('/data', 'en=item_added')");
    expect(js).toContain('en=add_to_cart&ep.via=beacon');
  });

  test('the gap frame is served for a path with a query', async () => {
    const res = await fetch(`${site.url}/web-pixels@0.0.0-fixture/sandbox/gap/?mode=custom`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('gap-pixel.js');
  });
});

describe('README and CHANGELOG', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const changelog = readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');

  test('the README lists the card server', () => {
    expect(readme).toContain('`paymentFrameUrl`');
    expect(readme).toContain('`cardSubmits`');
  });

  test('the README says the data-tag fallback email applies to every form (#476)', () => {
    const sentence = readme.split('\n').flatMap((l) => l.split(/(?<=\.) /)).find((s) => s.includes('In every form, the email is'));
    expect(sentence).toContain('pw-fixture@example.com');
    expect(sentence).toContain('nested');
    expect(sentence).toContain('flat-email');
    expect(sentence).toMatch(/not only/);
  });

  test('the CHANGELOG has the 0.4.0-rc.1 heading above 0.3.0, with one marker per PR in order', () => {
    const head = changelog.indexOf('## 0.4.0-rc.1');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(changelog.indexOf('## 0.3.0'));
    const section = changelog.slice(head, changelog.indexOf('## 0.3.0'));
    const ids = [...section.matchAll(/^<!-- ([A-Z]\d{2}) -->$/gm)].map((m) => m[1]);
    expect(ids).toEqual(['U02', 'U05', 'U04', 'U03', 'V01', 'V02', 'V04', 'V03', 'H07', 'H08', 'H02', 'H04', 'R01']);
    expect(section).toMatch(/^## 0\.4\.0-rc\.1\n\n<!-- U02 -->\n\n<!-- U05 -->\n\n/);
  });
});
