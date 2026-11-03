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

describe('Shopify-shaped card documents', () => {
  const doc = async (name: string) => (await fetch(`${site.paymentFrameUrl}/build/pwtest0/${name}`)).text();

  test('the number document has eight visible autofill inputs and a real number input without an id', async () => {
    const html = await doc('number-ltr.html');
    expect(html.match(/name="autofill-/g)).toHaveLength(8);
    expect(html).toContain('<input name="number" autocomplete="cc-number"');
    expect(html).not.toContain('id="cc-number"');
  });

  test('the expiry and security code documents use the Shopify names', async () => {
    expect(await doc('expiry-ltr.html')).toContain('name="expiry" autocomplete="cc-exp"');
    expect(await doc('verification_value-ltr.html')).toContain('name="verification_value" autocomplete="cc-csc"');
  });

  test('the decoy document keeps the old #cc-number id on its input', async () => {
    expect(await doc('decoy.html')).toContain('id="cc-number"');
  });

  test('other build paths are 404', async () => {
    expect((await fetch(`${site.paymentFrameUrl}/build/pwtest0/other.html`)).status).toBe(404);
  });

  test('the pages load the documents from the card host and the decoy comes first', async () => {
    const fields = await page('/checkout/test-payment-shopify-fields');
    expect(fields).toContain("paymentFrameUrl + '/build/pwtest0/'");
    expect(fields).toContain('id="pw-test-mode"');
    const decoy = await page('/checkout/test-payment-shopify-decoy');
    expect(decoy.indexOf('class="decoy"')).toBeGreaterThan(-1);
    expect(decoy.indexOf('class="decoy"')).toBeLessThan(decoy.indexOf('class="real"'));
  });
});

describe('/server-container', () => {
  test('is the file on disk and sends the pixel hit and the hit to the mock server container host', async () => {
    const html = await page('/server-container');
    expect(html).toBe(readFileSync(new URL('../public/server-container.html', import.meta.url), 'utf8'));
    expect(html).toContain('facebook.com/tr/?id=100000000000001&ev=Purchase&eid=');
    expect(html).toContain("send('/capi'");
  });

  test('the extra hits are behind ?extra=1', async () => {
    const html = await page('/server-container');
    expect(html).toContain("query.get('extra') === '1'");
    expect(html.split("send('/data'")).toHaveLength(2);
  });

  test('the mock server container host logs the method and path of each request', async () => {
    const before = site.sgtmRequests.length;
    await fetch(`${site.sgtmUrl}/capi?x=secret`, { method: 'POST', body: '{}' });
    expect(site.sgtmRequests.slice(before)).toEqual(['POST /capi']);
  });
});
