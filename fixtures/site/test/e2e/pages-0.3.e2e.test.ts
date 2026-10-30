import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../../src/index.ts';

function osToken(): string {
  switch (process.platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    default:
      return 'X11; Linux x86_64';
  }
}

function chromeUserAgent(browserVersion: string): string {
  return `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split('.')[0]}.0.0.0 Safari/537.36`;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const fakeEmail = 'pw-fixture@example.com';

function isLoopback(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

function isOffMachine(url: URL): boolean {
  return /^https?:$/.test(url.protocol) && !isLoopback(url);
}

let site: FixtureSite;
let browser: Browser;

beforeAll(async () => {
  site = await startFixtureSite();
  browser = await chromium.launch({ channel: 'chromium' });
});

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

interface Watch {
  context: BrowserContext;
  offMachine: URL[];
  answered: Set<string>;
  sgtm: { url: URL; body: Buffer | null }[];
}

// Every off-machine request is answered here, so none can reach the network.
async function open(): Promise<Watch> {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()) });
  const w: Watch = { context, offMachine: [], answered: new Set(), sgtm: [] };
  context.on('request', (request) => {
    const url = new URL(request.url());
    if (isOffMachine(url)) w.offMachine.push(url);
    if (url.origin === site.sgtmUrl) w.sgtm.push({ url, body: request.postDataBuffer() });
  });
  await context.route(
    (url) => isOffMachine(url),
    (route) => {
      w.answered.add(route.request().url());
      return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    },
  );
  return w;
}

function notAnswered(w: Watch): string[] {
  return w.offMachine.map((u) => u.href).filter((href) => !w.answered.has(href));
}

function sgtmBodies(w: Watch, event: string): Record<string, unknown>[] {
  return w.sgtm
    .filter((r) => r.url.pathname === '/data' && r.url.searchParams.get('event') === event && r.body)
    .map((r) => JSON.parse(r.body!.toString()) as Record<string, unknown>);
}

function offHits(w: Watch, host: string, pathPattern: RegExp): URL[] {
  return w.offMachine.filter((u) => u.hostname.endsWith(host) && pathPattern.test(u.pathname));
}

test('/sgtm-leak posts the whole dataLayer, then again after the answer', async () => {
  const w = await open();
  await w.context.addInitScript(() => sessionStorage.setItem('pw_checkout', JSON.stringify({ email: 'pw-fixture@example.com', phone: '+1 555 0100' })));
  const page = await w.context.newPage();
  await page.goto(`${site.url}/sgtm-leak`);
  await expect.poll(() => sgtmBodies(w, 'page_view').length).toBe(1);
  const first = sgtmBodies(w, 'page_view')[0]!;
  expect(Object.keys(first)).toEqual(
    expect.arrayContaining(['event_name', 'page_location', 'page_title', 'email', 'phone', 'address', 'cookie_data', 'clientIdHash']),
  );
  expect(first.email).toBe(fakeEmail);
  expect(String(first.clientIdHash)).toMatch(/^[0-9a-f]{64}$/);
  expect(sgtmBodies(w, 'after_consent')).toHaveLength(0);
  await page.click('#pw-reject');
  await expect.poll(() => sgtmBodies(w, 'after_consent').length).toBe(1);
  expect(notAnswered(w)).toEqual([]);
  await w.context.close();
});

test('/sgtm-leak?mode=allowlist posts four fields and no email', async () => {
  const w = await open();
  const page = await w.context.newPage();
  await page.goto(`${site.url}/sgtm-leak?mode=allowlist`);
  await expect.poll(() => sgtmBodies(w, 'page_view').length).toBe(1);
  const body = sgtmBodies(w, 'page_view')[0]!;
  expect(Object.keys(body).sort()).toEqual(['event_name', 'page_location', 'page_referrer', 'page_title']);
  await w.context.close();
});

test('/sgtm-leak?mode=huge posts a body over 64 KiB that still has the fields', async () => {
  const w = await open();
  const page = await w.context.newPage();
  await page.goto(`${site.url}/sgtm-leak?mode=huge`);
  await expect.poll(() => w.sgtm.length).toBeGreaterThan(0);
  const request = w.sgtm.find((r) => r.url.pathname === '/data')!;
  expect(request.url.search).toContain('v=2&event=page_view');
  expect(request.body!.length).toBeGreaterThan(64 * 1024);
  expect((JSON.parse(request.body!.toString()) as Record<string, unknown>).email).toBe(fakeEmail);
  await w.context.close();
});

test('/identifiers sends nothing until the banner is answered, then hashes of the typed email', async () => {
  const w = await open();
  const page = await w.context.newPage();
  await page.goto(`${site.url}/identifiers?state=denied`);
  const runEmail = 'pw-run-0001@example.com';
  await page.fill('#email', runEmail);
  await page.locator('#pw-consent-banner').waitFor({ state: 'visible' });
  await new Promise((r) => setTimeout(r, 1000));
  expect(w.offMachine).toEqual([]);
  expect(w.sgtm).toEqual([]);
  await page.click('#pw-reject');
  const hash = sha256(runEmail);
  expect(hash).not.toBe(sha256(fakeEmail));
  await expect.poll(() => sgtmBodies(w, 'purchase').length).toBe(1);
  const ga4 = offHits(w, 'google-analytics.com', /^\/g\/collect$/)[0]!;
  expect(ga4.searchParams.get('uid')).toBe('fixture-user-0001');
  expect(ga4.searchParams.get('ep.token')).toBe(hash);
  expect(ga4.searchParams.get('gcs')).toBe('G100');
  const meta = offHits(w, 'facebook.com', /^\/tr\/?$/)[0]!;
  expect(meta.searchParams.get('ud[em]')).toBe(hash);
  expect(meta.searchParams.get('external_id')).toBe(hash);
  const sgtm = sgtmBodies(w, 'purchase')[0] as { user_data: { email_address: string }; external_id: string };
  expect(sgtm.user_data.email_address).toBe(hash);
  expect(sgtm.external_id).toBe(hash);
  expect(notAnswered(w)).toEqual([]);
  await w.context.close();
});

test('/identifiers?state=granted claims granted signals, and ?control=1 sends no identifier', async () => {
  const granted = await open();
  const page = await granted.context.newPage();
  await page.goto(`${site.url}/identifiers?state=granted`);
  await page.click('#pw-accept');
  await expect.poll(() => offHits(granted, 'google-analytics.com', /collect/).length).toBe(1);
  expect(offHits(granted, 'google-analytics.com', /collect/)[0]!.searchParams.get('gcs')).toBe('G111');
  await granted.context.close();

  const control = await open();
  const controlPage = await control.context.newPage();
  await controlPage.goto(`${site.url}/identifiers?control=1`);
  await controlPage.click('#pw-reject');
  await expect.poll(() => offHits(control, 'facebook.com', /^\/tr\/?$/).length).toBe(1);
  const ga4 = offHits(control, 'google-analytics.com', /collect/)[0]!;
  expect([...ga4.searchParams.keys()].some((k) => ['uid', 'ep.token', 'external_id'].includes(k))).toBe(false);
  expect(ga4.searchParams.get('cid')).toBeTruthy();
  const meta = offHits(control, 'facebook.com', /^\/tr\/?$/)[0]!;
  expect(meta.searchParams.get('fbp')).toBeTruthy();
  expect(meta.searchParams.has('ud[em]')).toBe(false);
  expect(control.sgtm).toEqual([]);
  await control.context.close();
});

test('/cookies?when=before sets _pwid at once, ?when=after only after the answer', async () => {
  const before = await open();
  const beforePage = await before.context.newPage();
  const beforeStart = beforePage.waitForResponse((r) => r.url().endsWith('/session/start'));
  await beforePage.goto(`${site.url}/cookies?when=before`);
  expect((await (await beforeStart).allHeaders())['set-cookie']).toContain('_pwid=');
  await before.context.close();

  const after = await open();
  const requested: string[] = [];
  after.context.on('request', (r) => requested.push(r.url()));
  const afterPage = await after.context.newPage();
  await afterPage.goto(`${site.url}/cookies?when=after`);
  await afterPage.locator('#pw-consent-banner').waitFor({ state: 'visible' });
  await new Promise((r) => setTimeout(r, 500));
  expect(requested.some((u) => u.endsWith('/session/start'))).toBe(false);
  const started = afterPage.waitForResponse((r) => r.url().endsWith('/session/start'));
  await afterPage.click('#pw-accept');
  expect((await (await started).allHeaders())['set-cookie']).toContain('_pwid=');
  const names = (await after.context.cookies(site.url)).map((c) => c.name);
  expect(names).toContain('_ga_PWTEST');
  await after.context.close();
});

test('/cookies sends the Stape loader request and the mock host answers Set-Cookie', async () => {
  const w = await open();
  const page = await w.context.newPage();
  const loader = page.waitForResponse((r) => new URL(r.url()).pathname === '/pwcookie');
  await page.goto(`${site.url}/cookies`);
  const response = await loader;
  expect((await response.allHeaders())['set-cookie']).toContain('_pwdcid=');
  const real = Buffer.from(new URL(response.url()).searchParams.get('pk')!, 'base64').toString();
  expect(real).toBe('/data?v=2&event=page_view');
  await w.context.close();
});

test('/tiles themes expose the tiles by role or by title', async () => {
  const w = await open();
  const page = await w.context.newPage();
  for (const [theme, role] of [['button', 'button'], ['radio', 'radio']] as const) {
    await page.goto(`${site.url}/tiles?theme=${theme}`);
    await page.getByRole(role, { name: 'White (01)' }).click();
    expect(await page.locator('#selected').textContent()).toBe('White (01)');
    await page.goto(`${site.url}/tiles?theme=${theme}`);
    await page.locator('text=White (01)').click();
    expect(await page.locator('#selected').textContent()).toBe('White (01)');
    expect(await page.getByRole(role, { name: 'Black (02)' }).count()).toBe(1);
  }
  await page.goto(`${site.url}/tiles?theme=radio`);
  expect(await page.getByRole('button', { name: 'White (01)' }).count()).toBe(0);
  await page.goto(`${site.url}/tiles?theme=plain`);
  expect(await page.getByRole('radio').count()).toBe(0);
  await page.getByTitle('Black (02)').click();
  expect(await page.locator('#selected').textContent()).toBe('Black (02)');
  await w.context.close();
});

test('/select applies a value, and ?broken=1 resets it', async () => {
  const w = await open();
  const page = await w.context.newPage();
  await page.goto(`${site.url}/select?send=hash`);
  await page.selectOption('select[name=countryCode]', 'DE');
  expect(await page.locator('#current').textContent()).toBe('DE');
  await expect.poll(() => sgtmBodies(w, 'country_selected').length).toBe(1);
  expect(sgtmBodies(w, 'country_selected')[0]!.country).toBe(sha256('de'));

  await page.goto(`${site.url}/select?broken=1`);
  await page.selectOption('select[name=countryCode]', { label: 'Germany' });
  await expect.poll(() => page.locator('select[name=countryCode]').inputValue()).toBe('');
  expect(await page.locator('#current').textContent()).toBe('');
  expect(notAnswered(w)).toEqual([]);
  await w.context.close();
});

test('/handoff has a form and a link to a second page, and ?listener=1 sends a hit on click', async () => {
  const w = await open();
  const page = await w.context.newPage();
  await page.goto(`${site.url}/handoff`);
  await page.fill('#note', 'hello');
  await page.click('#handoff-submit');
  expect(await page.locator('#saved').textContent()).toBe('saved');
  expect(w.offMachine).toEqual([]);
  await page.click('#to-second');
  await page.waitForURL('**/handoff/second');
  await page.goto(`${site.url}/handoff?listener=1`);
  await page.click('#handoff-submit');
  await expect.poll(() => offHits(w, 'google-analytics.com', /collect/).length).toBe(1);
  expect(notAnswered(w)).toEqual([]);
  await w.context.close();
});
