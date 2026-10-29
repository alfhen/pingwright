import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { answerBanner, buildEpochs, consentModeChanges, installConsent, type ConsentPush } from '../../src/index.ts';

function chromeUserAgent(browserVersion: string, product = 'Chrome'): string {
  const os =
    process.platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : process.platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) ${product}/${browserVersion.split('.')[0]}.0.0.0 Safari/537.36`;
}

function isOffMachine(url: URL): boolean {
  return /^https?:$/.test(url.protocol) && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
}

const recordPushes = `
  window.__pwPushes = [];
  window.dataLayer = [];
  const push = window.dataLayer.push;
  window.dataLayer.push = function (...items) {
    for (const item of items) {
      const args = Object.prototype.toString.call(item) === '[object Arguments]' ? Array.from(item) : item;
      window.__pwPushes.push({ t: performance.timeOrigin + performance.now(), args });
    }
    return push.apply(this, items);
  };
`;

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

// Nothing leaves the machine: tag scripts are replaced by empty scripts and every other off-machine request gets a 204.
async function newContext(product = 'Chrome'): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version(), product) });
  await context.route(isOffMachine, (route) => {
    if (route.request().resourceType() === 'script') {
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    }
    return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
  });
  await context.route('https://collector.pingwright.invalid/**', (route) =>
    route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } }),
  );
  await context.addInitScript(recordPushes);
  return context;
}

async function pushes(page: Page): Promise<ConsentPush[]> {
  return page.evaluate(() => (window as unknown as { __pwPushes: ConsentPush[] }).__pwPushes);
}

async function storedChoice(context: BrowserContext): Promise<string | undefined> {
  return (await context.cookies(site.url)).find((c) => c.name === 'pw_consent')?.value;
}

test('accept detects the fixture banner and accepts', async () => {
  const context = await newContext();
  await installConsent(context);
  const page = await context.newPage();
  await page.goto(site.url);
  const result = await answerBanner(page, 'accept', { timeoutMs: 10_000 });
  expect(result).toMatchObject({ detected: true, shown: true, cmp: 'pingwright-fixture', action: 'accept', result: 'ok' });
  expect(await storedChoice(context)).toBe('accept');
  expect(await page.locator('#pw-consent-banner').isVisible()).toBe(false);
  await context.close();
});

test('reject detects the fixture banner and rejects', async () => {
  const context = await newContext();
  await installConsent(context);
  const page = await context.newPage();
  await page.goto(site.url);
  const result = await answerBanner(page, 'reject');
  expect(result).toMatchObject({ detected: true, shown: true, action: 'reject', result: 'ok' });
  expect(await storedChoice(context)).toBe('reject');
  await context.close();
});

test('none detects the fixture banner and takes no action', async () => {
  const context = await newContext();
  await installConsent(context);
  const page = await context.newPage();
  await page.goto(site.url);
  const result = await answerBanner(page, 'none');
  expect(result).toMatchObject({ detected: true, shown: true, action: 'none', result: 'ok' });
  expect(await page.locator('#pw-consent-banner').isVisible()).toBe(true);
  expect(await storedChoice(context)).toBeUndefined();
  await context.close();
});

test('accept, reopen the banner, then reject', async () => {
  const context = await newContext();
  await installConsent(context);
  const page = await context.newPage();
  const startT = Date.now();
  await page.goto(site.url);
  const accepted = await answerBanner(page, 'accept');
  expect(accepted.result).toBe('ok');
  await page.click('#pw-cookie-settings');
  expect(await page.locator('#pw-consent-banner').isVisible()).toBe(true);
  const rejected = await answerBanner(page, 'reject');
  expect(rejected).toMatchObject({ result: 'ok', action: 'reject' });
  expect(await storedChoice(context)).toBe('reject');
  expect(await page.locator('#pw-consent-banner').isVisible()).toBe(false);

  const recorded = await pushes(page);
  const epochs = buildEpochs(
    [
      { t: accepted.t, action: 'accept' },
      { t: rejected.t, action: 'reject' },
    ],
    consentModeChanges(recorded),
    { startT },
  );
  const updates = consentModeChanges(recorded).filter((c) => c.command === 'update');
  expect(updates.map((u) => u.state.analytics)).toEqual(['granted', 'denied']);
  expect(epochs.map((e) => e.label)).toEqual(['undecided', 'granted', 'denied']);
  expect(epochs[0]?.state.analytics).toBe('denied');
  await context.close();
});

test('accept, navigate, wait, reopen, then reject', async () => {
  const context = await newContext();
  await installConsent(context);
  const page = await context.newPage();
  await page.goto(site.url);
  expect((await answerBanner(page, 'accept')).result).toBe('ok');
  await page.goto(new URL('/products/fake-tee', site.url).href);
  await page.waitForTimeout(7000);
  await page.click('#pw-cookie-settings');
  expect(await page.locator('#pw-consent-banner').isVisible()).toBe(true);
  expect(await answerBanner(page, 'reject', { timeoutMs: 5000 })).toMatchObject({ shown: true, result: 'ok' });
  expect(await storedChoice(context)).toBe('reject');
  await context.close();
}, 30_000);

test('a second answer without reopening the banner gives banner not shown', async () => {
  const context = await newContext();
  await installConsent(context);
  const page = await context.newPage();
  await page.goto(site.url);
  expect((await answerBanner(page, 'accept')).result).toBe('ok');
  expect(await answerBanner(page, 'reject', { timeoutMs: 1500 })).toMatchObject({ shown: false, result: 'banner not shown' });
  expect(await answerBanner(page, 'none', { timeoutMs: 1500 })).toMatchObject({ shown: false, result: 'banner not shown' });
  expect(await storedChoice(context)).toBe('accept');
  await context.close();
});

test('a rule with an eval step detects and acts', async () => {
  const context = await newContext();
  await context.addInitScript(`window.Cookiebot = { hasResponse: false, dialog: { visible: true } };`);
  await installConsent(context, {
    fixtureRules: false,
    disabledCmps: ['Cybotcookiebot'],
    ruleFiles: [fileURLToPath(new URL('./eval-rule.json', import.meta.url))],
  });
  const page = await context.newPage();
  await page.goto(site.url);
  const result = await answerBanner(page, 'reject');
  expect(result).toMatchObject({ detected: true, shown: true, cmp: 'pingwright-eval-test', result: 'ok' });
  expect(await storedChoice(context)).toBe('reject');
  await context.close();
});

test('a rule whose eval step fails gives banner not shown', async () => {
  const context = await newContext();
  await context.addInitScript(`window.Cookiebot = { hasResponse: false, dialog: { visible: false } };`);
  await installConsent(context, {
    fixtureRules: false,
    disabledCmps: ['Cybotcookiebot'],
    ruleFiles: [fileURLToPath(new URL('./eval-rule.json', import.meta.url))],
  });
  const page = await context.newPage();
  await page.goto(site.url);
  const result = await answerBanner(page, 'reject', { timeoutMs: 2000 });
  expect(result).toMatchObject({ shown: false, result: 'banner not shown' });
  expect(await storedChoice(context)).toBeUndefined();
  await context.close();
});

test('answerBanner works on a page loaded before any install', async () => {
  const context = await newContext();
  const page = await context.newPage();
  await page.goto(site.url);
  const result = await answerBanner(page, 'accept');
  expect(result).toMatchObject({ detected: true, shown: true, action: 'accept', result: 'ok' });
  expect(await storedChoice(context)).toBe('accept');
  await context.close();
});

test('answerBanner rejects options that differ from the installed ones', async () => {
  const context = await newContext();
  await installConsent(context, { detectRetries: 3 });
  const page = await context.newPage();
  await page.goto(site.url);
  await expect(answerBanner(page, 'none', { detectRetries: 5 })).rejects.toThrow(/detectRetries/);
  await expect(answerBanner(page, 'none', { detectRetries: 3 })).resolves.toMatchObject({ result: 'ok' });
  await context.close();
});

test('a HeadlessChrome user agent gives banner not shown', async () => {
  const context = await newContext('HeadlessChrome');
  const driver = await installConsent(context);
  const page = await context.newPage();
  await page.goto(site.url);
  await expect.poll(() => driver.isRunningIn(page.mainFrame())).toBe(true);
  for (const action of ['accept', 'reject', 'none'] as const) {
    const result = await answerBanner(page, action, { timeoutMs: 2000 });
    expect(result).toMatchObject({ shown: false, result: 'banner not shown', action });
  }
  expect(await storedChoice(context)).toBe('accept');
  await context.close();
});
