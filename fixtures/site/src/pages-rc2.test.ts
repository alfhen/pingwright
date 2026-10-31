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

describe('route table', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const routes = [...source.matchAll(/^ {2}'(\/[^']*)': '[^']+\.html',$/gm)].map((m) => m[1]!);

  test('the route list was read from index.ts', () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes).toContain('/meta-early');
  });

  test.each(routes)('README has a row or mention for %s', (route) => {
    expect(readme).toContain(`\`${route}\``);
  });

  test.each(routes)('%s answers 200', async (route) => {
    expect((await fetch(site.url + route)).status).toBe(200);
  });
});

describe('/set-cookie-unstored', () => {
  test('the endpoint sets a cookie whose Domain does not match the host', async () => {
    const res = await fetch(`${site.url}/session/unstored`);
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('_pwunstored=pw-fixture-cookie-value');
    expect(cookie).toContain('Domain=other.example');
    expect(new URL(site.url).hostname).not.toMatch(/other\.example$/);
  });

  test('the page requests the endpoint on load', async () => {
    const html = await page('/set-cookie-unstored');
    expect(html).toContain("fetch('/session/unstored')");
    expect(html).toContain('/assets/banner.js');
  });
});

describe('/sgtm-data-tag variants', () => {
  test('nested and flat-email forms exist with the fake identity', async () => {
    const html = await page('/sgtm-data-tag?form=nested');
    expect(html).toContain("form === 'nested'");
    expect(html).toContain('customerHashed: { email: h.email_address }');
    expect(html).toContain("form === 'flat-email'");
    expect(html).toContain('email: h.email_address }');
    expect(html).toContain('pw-fixture@example.com');
  });
});

describe('/meta-early', () => {
  test('sends a Meta hit for the fake pixel and sets no Consent Mode default', async () => {
    const html = await page('/meta-early');
    expect(html).toContain('facebook.com/tr/?id=100000000000001');
    expect(html).not.toContain('banner.js');
    expect(html).not.toContain('site.js');
    expect(html).not.toMatch(/consent['"]\s*,\s*['"]default/);
    expect(html).not.toContain('gtag');
  });
});

describe('/handoff-patched', () => {
  test('patches the accessors before any other script and records what they receive', async () => {
    const html = await page('/handoff-patched');
    expect(html).toContain("Object.getOwnPropertyDescriptor(Node.prototype, 'textContent')");
    expect(html).toContain("Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')");
    expect(html).toContain('Node.prototype.getRootNode');
    expect(html).toContain('window.__pwPatched');
    expect(html.indexOf('__pwPatched')).toBeLessThan(html.indexOf('<body>'));
    expect(html).toContain('id="handoff-submit"');
  });
});

describe('/tiles?theme=radio-mixed', () => {
  test('puts a link and a button before the radios', async () => {
    const html = await page('/tiles?theme=radio-mixed');
    expect(html).toContain("theme === 'radio-mixed'");
    expect(html).toContain("link.textContent = 'Size guide'");
    expect(html).toContain("button.textContent = 'Help'");
    expect(html.indexOf("'radio-mixed'")).toBeLessThan(html.indexOf("tile.setAttribute('role', 'radio')"));
  });
});
