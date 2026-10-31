import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HANDOFF_DONE_BINDING, HANDOFF_HOST_ID, launchRecorder, playScenario } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'handoff-overlay-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const terminal = (_text: string, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));

async function open(path: string, after = "  - click: '#handoff-submit'\n") {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url, headed: false, handoffOverlay: true });
  const scenario = parseScenario(`start: ${path}\nsteps:\n  - handoff: Pay the test order\n${after}`);
  let finished = false;
  const played = playScenario(recorder, scenario, { handoffResolver: terminal, print: () => {} }).finally(() => (finished = true));
  played.catch(() => undefined);
  await expect.poll(() => recorder.context.pages().length, { timeout: 20_000 }).toBe(1);
  const page = recorder.context.pages()[0]!;
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain(path);
  await page.waitForLoadState('load');
  return { recorder, page, played, finished: () => finished };
}

async function pillBox(page: Page) {
  const host = page.locator(`#${HANDOFF_HOST_ID}`);
  await host.waitFor({ state: 'visible', timeout: 15_000 });
  const box = await host.boundingBox();
  if (!box) throw new Error('the pill has no box');
  return box;
}

/** The Done button is inside a closed shadow root, so the test clicks where it is drawn, as a person would. */
async function clickDone(page: Page) {
  const box = await pillBox(page);
  await page.mouse.click(box.x + box.width - 26, box.y + box.height / 2);
}

test('the pill shows on the open document and the Done button ends the wait', async () => {
  const run = await open('/handoff');
  await pillBox(run.page);
  expect(run.finished()).toBe(false);
  await clickDone(run.page);
  await run.played;
  expect(await run.page.locator('#saved').textContent()).toBe('saved');
  await run.recorder.close();
}, 60_000);

test('the pill survives a navigation during the handoff', async () => {
  const run = await open('/handoff', '');
  await pillBox(run.page);
  await run.page.goto(`${site.url}/handoff/second`);
  await pillBox(run.page);
  expect(run.finished()).toBe(false);
  await clickDone(run.page);
  await run.played;
  await run.recorder.close();
}, 60_000);

test('the overlay makes no request and a page script cannot end the wait', async () => {
  const run = await open('/handoff');
  await pillBox(run.page);
  await run.page.evaluate(async (name) => {
    const done = (window as unknown as Record<string, (n?: unknown) => Promise<unknown>>)[name]!;
    await done();
    await done('guess');
    const host = document.getElementById('pingwright-handoff')!;
    host.click();
    host.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, HANDOFF_DONE_BINDING);
  await run.page.waitForTimeout(1200);
  expect(run.finished()).toBe(false);
  await clickDone(run.page);
  await run.played;
  const { records } = await run.recorder.close();
  expect(records.requests.some((r) => r.url.includes(HANDOFF_HOST_ID))).toBe(false);
}, 60_000);

test('hostile site CSS does not hide the pill or move it off screen', async () => {
  const run = await open('/handoff');
  await run.page.addStyleTag({
    content: '#pingwright-handoff { display: none !important; left: -9999px !important; visibility: hidden !important; opacity: 0 !important }',
  });
  const box = await pillBox(run.page);
  expect(box.x).toBeGreaterThanOrEqual(0);
  await clickDone(run.page);
  await run.played;
  await run.recorder.close();
}, 60_000);

test('a document-level bubble click listener does not see the click on Done', async () => {
  const run = await open('/handoff', '');
  await run.page.evaluate(() => {
    let n = 0;
    document.addEventListener('click', () => {
      new Image().src = `https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1111111111.2222222222&en=click_${++n}`;
    });
  });
  await run.page.click('#handoff-submit');
  await clickDone(run.page);
  await run.played;
  const { records } = await run.recorder.close();
  expect(records.hits.filter((h) => h.vendor === 'ga4').map((h) => h.event)).toEqual(['click_1']);
}, 60_000);

test('a dragged pill stays where it was dropped', async () => {
  const run = await open('/handoff');
  const before = await pillBox(run.page);
  const grabX = before.x + 8;
  const grabY = before.y + before.height / 2;
  await run.page.mouse.move(grabX, grabY);
  await run.page.mouse.down();
  await run.page.mouse.move(grabX - 300, grabY - 200, { steps: 5 });
  await run.page.mouse.up();
  const dropped = await pillBox(run.page);
  expect(Math.abs(dropped.x - (before.x - 300))).toBeLessThan(3);
  expect(Math.abs(dropped.y - (before.y - 200))).toBeLessThan(3);
  await run.page.waitForTimeout(1600);
  const later = await pillBox(run.page);
  expect(later.x).toBe(dropped.x);
  expect(later.y).toBe(dropped.y);
  await clickDone(run.page);
  await run.played;
  await run.recorder.close();
}, 60_000);

test('a second handoff in the same document shows the pill again', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url, headed: false, handoffOverlay: true });
  const scenario = parseScenario(
    "start: /handoff\nsteps:\n  - handoff: Log in\n  - click: '#handoff-submit'\n  - wait: 1500\n  - handoff: Pay the test order\n",
  );
  const played = playScenario(recorder, scenario, { handoffResolver: terminal, print: () => {} });
  played.catch(() => undefined);
  await expect.poll(() => recorder.context.pages().length, { timeout: 20_000 }).toBe(1);
  const page = recorder.context.pages()[0]!;
  await page.waitForLoadState('load');
  await clickDone(page);
  await expect.poll(() => page.locator('#saved').textContent(), { timeout: 10_000 }).toBe('saved');
  await expect.poll(() => page.locator(`#${HANDOFF_HOST_ID}`).count(), { timeout: 10_000 }).toBe(0);
  await expect.poll(() => page.locator(`#${HANDOFF_HOST_ID}`).count(), { timeout: 10_000 }).toBe(1);
  await clickDone(page);
  await played;
  await recorder.close();
}, 60_000);
