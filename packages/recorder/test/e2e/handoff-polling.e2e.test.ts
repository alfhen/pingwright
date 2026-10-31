import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HANDOFF_HOST_ID, HANDOFF_WAKE_EVENT, launchRecorder, playScenario, type HandoffState } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'handoff-polling-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const terminal = (_text: string, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pillCount(page: Page) {
  return page.locator(`#${HANDOFF_HOST_ID}`).count();
}

async function clickDone(page: Page) {
  const host = page.locator(`#${HANDOFF_HOST_ID}`);
  await host.waitFor({ state: 'visible', timeout: 15_000 });
  const box = (await host.boundingBox())!;
  await page.mouse.click(box.x + box.width - 26, box.y + box.height / 2);
}

/** Counts calls of the state binding. While `hold` is set, the next call answers only when `release` runs, with the state it saw when it was made. */
async function launch() {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url, headed: false, handoffOverlay: true });
  const real = recorder.handoff.state.bind(recorder.handoff);
  const control = { calls: 0, hold: false, release: () => {} };
  (recorder.handoff as { state: () => HandoffState | Promise<HandoffState> }).state = () => {
    control.calls++;
    const seen = real();
    if (!control.hold) return seen;
    control.hold = false;
    return new Promise<HandoffState>((resolve) => (control.release = () => resolve(seen)));
  };
  return { recorder, control };
}

test('the pill stops asking for the state when no handoff waits, and asks again on the next one', async () => {
  const { recorder, control } = await launch();
  const scenario = parseScenario("start: /handoff\nsteps:\n  - handoff: Log in\n  - click: '#handoff-submit'\n  - wait: 5000\n  - handoff: Pay the test order\n");
  const played = playScenario(recorder, scenario, { handoffResolver: terminal, print: () => {} });
  played.catch(() => undefined);
  await expect.poll(() => recorder.context.pages().length, { timeout: 20_000 }).toBe(1);
  const page = recorder.context.pages()[0]!;
  await page.waitForLoadState('load');
  await clickDone(page);
  await expect.poll(() => pillCount(page), { timeout: 10_000 }).toBe(0);
  await sleep(1500);
  const quiet = control.calls;
  await sleep(2000);
  expect(control.calls).toBe(quiet);
  await expect.poll(() => pillCount(page), { timeout: 15_000 }).toBe(1);
  expect(control.calls).toBeGreaterThan(quiet);
  await clickDone(page);
  await played;
  await recorder.close();
}, 60_000);

test('a stale not-waiting answer does not stop the polling that a wake started', async () => {
  const { recorder, control } = await launch();
  const page = await recorder.context.newPage();
  await page.goto(`${site.url}/handoff`);
  await sleep(1500);
  const quiet = control.calls;
  await sleep(1200);
  expect(control.calls).toBe(quiet);

  control.hold = true;
  await page.evaluate((name) => window.dispatchEvent(new Event(name)), HANDOFF_WAKE_EVENT);
  await expect.poll(() => control.hold, { timeout: 5_000 }).toBe(false);

  void recorder.handoff.begin('Pay the test order');
  await page.evaluate((name) => window.dispatchEvent(new Event(name)), HANDOFF_WAKE_EVENT);
  await expect.poll(() => pillCount(page), { timeout: 5_000 }).toBe(1);

  control.release();
  await sleep(1500);
  expect(await pillCount(page)).toBe(1);

  recorder.handoff.end();
  await expect.poll(() => pillCount(page), { timeout: 5_000 }).toBe(0);
  await recorder.close();
}, 60_000);
