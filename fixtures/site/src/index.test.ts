import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

const b64 = (s: string) => encodeURIComponent(Buffer.from(s).toString('base64'));

describe('hosts', () => {
  test('shop is on localhost and the other two are on 127.0.0.1 at different ports', () => {
    const urls = [site.url, site.sgtmUrl, site.thirdPartyUrl].map((u) => new URL(u));
    expect(urls[0]?.hostname).toBe('localhost');
    expect(urls[1]?.hostname).toBe('127.0.0.1');
    expect(urls[2]?.hostname).toBe('127.0.0.1');
    expect(new Set(urls.map((u) => u.port)).size).toBe(3);
  });
});

describe('shop pages', () => {
  const paths = ['/', '/products/fake-tee', '/collections/all', '/cart', '/checkout', '/checkout/payment', '/thank-you'];
  test.each(paths)('%s serves HTML with the shared scripts', async (path) => {
    const res = await fetch(site.url + path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('/assets/site.js');
  });

  test('unknown paths are 404', async () => {
    expect((await fetch(`${site.url}/nope`)).status).toBe(404);
    expect((await fetch(`${site.url}/assets/../src/index.ts`)).status).toBe(404);
  });

  test('config script carries the other two hosts', async () => {
    const js = await (await fetch(`${site.url}/fixture-config.js`)).text();
    expect(js).toContain(site.sgtmUrl);
    expect(js).toContain(site.thirdPartyUrl);
  });

  test('the sandbox pixel page is served at the web-pixels path', async () => {
    const res = await fetch(`${site.url}/web-pixels@0.0.0-fixture/sandbox/modern/`);
    expect(res.status).toBe(200);
  });

  test('checkout has the identity, country and payment elements', async () => {
    const checkout = await (await fetch(`${site.url}/checkout`)).text();
    for (const id of ['email', 'first-name', 'last-name', 'phone', 'address1', 'city', 'zip', 'country', 'continue']) {
      expect(checkout).toContain(`id="${id}"`);
    }
    const payment = await (await fetch(`${site.url}/checkout/payment`)).text();
    expect(payment).toContain('id="card-number" autocomplete="cc-number"');
    expect(payment).toContain('id="card-expiry" autocomplete="cc-exp"');
    expect(payment).toContain('id="card-cvc" autocomplete="cc-csc"');
    expect(payment).toContain('id="pay"');
  });
});

describe('mock server container', () => {
  test('answers /gtag/js with a script and everything else with 204', async () => {
    const js = await fetch(`${site.sgtmUrl}/pwstape?pk=${b64('/gtag/js?id=G-PWTEST0001')}`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${site.sgtmUrl}/pwstape?pk=${b64('/g/collect?v=2')}`)).status).toBe(204);
    expect((await fetch(`${site.sgtmUrl}/pwstape?pk=${b64('/data?v=2')}`)).status).toBe(204);
    expect((await fetch(`${site.sgtmUrl}/other`)).status).toBe(204);
  });
});

describe('third-party host', () => {
  test('answers any path with an image', async () => {
    const res = await fetch(`${site.thirdPartyUrl}/unknown-pixel?x=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/gif');
  });
});

test('close stops all three servers', async () => {
  const other = await startFixtureSite();
  await other.close();
  await expect(fetch(other.url)).rejects.toThrow();
  await expect(fetch(other.sgtmUrl)).rejects.toThrow();
  await expect(fetch(other.thirdPartyUrl)).rejects.toThrow();
});
