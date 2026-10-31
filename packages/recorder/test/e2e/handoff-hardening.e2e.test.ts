import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HANDOFF_HOST_ID, launchRecorder, playScenario } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'handoff-hardening-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const terminal = (_text: string, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));

const LONG_TEXT = 'Pay the test order with the fake card on the checkout page, then wait here until the confirmation number shows up on screen';

async function open(path: string, text: string, narrow = false, initScript?: string) {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url, headed: false, handoffOverlay: true });
  if (initScript) await recorder.context.addInitScript(initScript);
  const scenario = parseScenario(`start: ${path}\nsteps:\n  - handoff: ${JSON.stringify(text)}\n`);
  const played = playScenario(recorder, scenario, { handoffResolver: terminal, print: () => {} });
  played.catch(() => undefined);
  await expect.poll(() => recorder.context.pages().length, { timeout: 20_000 }).toBe(1);
  const page = recorder.context.pages()[0]!;
  await expect.poll(() => page.url(), { timeout: 20_000 }).toContain(path);
  await page.waitForLoadState('load');
  if (narrow) await page.setViewportSize({ width: 390, height: 844 });
  return { recorder, page, played };
}

async function pillBox(page: Page) {
  const host = page.locator(`#${HANDOFF_HOST_ID}`);
  await host.waitFor({ state: 'visible', timeout: 15_000 });
  const box = await host.boundingBox();
  if (!box) throw new Error('the pill has no box');
  return box;
}

async function clickDone(page: Page) {
  const box = await pillBox(page);
  await page.mouse.click(box.x + box.width - 26, box.y + box.height / 2);
}

test('a page that patches textContent, style and getRootNode never receives the label or the host', async () => {
  const run = await open('/handoff-patched', 'Pay the test order');
  await pillBox(run.page);
  await clickDone(run.page);
  await run.played;
  await expect.poll(() => run.page.locator(`#${HANDOFF_HOST_ID}`).count(), { timeout: 10_000 }).toBe(0);
  const seen = await run.page.evaluate(
    () => (window as unknown as { __pwPatched: { textContent: string[]; style: string[]; rootNodes: string[] } }).__pwPatched,
  );
  expect(seen.textContent).not.toContain('Pay the test order');
  expect(seen.style).not.toContain('div#pingwright-handoff');
  expect(seen.rootNodes).not.toContain('[object ShadowRoot]');
  await run.recorder.close();
}, 60_000);

test('a page that patches Function.prototype.call and Event.prototype.stopPropagation never sees the label or the closed root', async () => {
  const run = await open('/handoff', 'Pay the test order', false, `(() => {
    const seen = { call: [], stop: [], str: [] };
    window.__pwSeen = seen;
    const NativeString = String;
    window.String = function (v) {
      const text = NativeString(v);
      if (text.includes('Pay the test order')) seen.str.push(text);
      return text;
    };
    const call = Function.prototype.call;
    Function.prototype.call = function (self, ...args) {
      try { seen.call.push(String(self) + '|' + args.map(String).join(',')); } catch {}
      return call.apply(this, [self, ...args]);
    };
    const stop = Event.prototype.stopPropagation;
    Event.prototype.stopPropagation = function () {
      try { seen.stop.push(String(this.currentTarget)); } catch {}
      return stop.call(this);
    };
  })();`);
  const box = await pillBox(run.page);
  await run.page.mouse.move(box.x + 20, box.y + box.height / 2);
  await run.page.mouse.down();
  await run.page.mouse.move(box.x - 40, box.y - 40, { steps: 4 });
  await run.page.mouse.up();
  await clickDone(run.page);
  await run.played;
  const seen = await run.page.evaluate(() => (window as unknown as { __pwSeen: { call: string[]; stop: string[]; str: string[] } }).__pwSeen);
  expect(seen.str.join('\n')).not.toContain('Pay the test order');
  expect(seen.call.join('\n')).not.toContain('Pay the test order');
  expect(seen.call.join('\n')).not.toContain('HTMLSpanElement');
  expect(seen.stop).not.toContain('[object ShadowRoot]');
  await run.recorder.close();
}, 60_000);

test('a long handoff text keeps the pill inside a 390 px viewport with the Done button whole', async () => {
  const run = await open('/handoff', LONG_TEXT, true);
  const box = await pillBox(run.page);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.width).toBeLessThanOrEqual(358);
  await clickDone(run.page);
  await run.played;
  await run.recorder.close();
}, 60_000);
