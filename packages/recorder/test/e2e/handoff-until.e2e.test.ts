import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HANDOFF_HOST_ID, launchRecorder, playScenario, StepError } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'handoff-until-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const terminal = (_text: string, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
const FAKE_EMAIL = 'pw-fixture@example.com';

async function play(handoff: string) {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url, headed: false, handoffOverlay: true });
  const scenario = parseScenario(`start: /handoff/until\nsteps:\n  - handoff: ${handoff}\n    label: pay\n`);
  const printed: string[] = [];
  const started = Date.now();
  const played = playScenario(recorder, scenario, { handoffResolver: terminal, print: (t) => printed.push(t) });
  played.catch(() => undefined);
  await expect.poll(() => recorder.context.pages().length, { timeout: 20_000 }).toBe(1);
  const page = recorder.context.pages()[0]!;
  await page.waitForLoadState('load');
  await page.locator(`#${HANDOFF_HOST_ID}`).waitFor({ state: 'visible', timeout: 15_000 });
  return { recorder, page, played, printed, started };
}

const payStep = (records: { steps: { label: string; handoffEnd?: string; error?: string }[] }) => records.steps.find((s) => s.label === 'pay')!;

test('the handoff ends by itself when the URL matches, and settle keeps the late purchase', async () => {
  const run = await play('{ text: Pay the test order, until: { url: "/thank-you*" }, settle: 3s, timeout: 60s }');
  await run.page.evaluate((email) => {
    const input = document.createElement('input');
    input.id = 'typed';
    document.body.append(input);
    input.value = email;
  }, FAKE_EMAIL);
  await run.page.waitForTimeout(500);
  await run.page.locator('#pw-to-thank-you').click();
  await run.played;
  expect(Date.now() - run.started).toBeLessThan(10_000 + 3_000);
  const { records } = await run.recorder.close();
  const step = payStep(records);
  expect(step.handoffEnd).toBe('until');
  expect(step.error).toBeUndefined();
  expect(records.hits.some((h) => h.vendor === 'ga4' && h.event === 'purchase')).toBe(true);
  expect(run.printed).toContain('Handoff ended: reached /thank-you*');
  expect(JSON.stringify(step) + run.printed.join('\n')).not.toContain(FAKE_EMAIL);
}, 60_000);

test('without settle the late purchase is cut off', async () => {
  const run = await play('{ text: Pay the test order, until: { url: "/thank-you*" }, settle: 0s, timeout: 60s }');
  await run.page.locator('#pw-to-thank-you').click();
  await run.played;
  const { records } = await run.recorder.close();
  expect(payStep(records).handoffEnd).toBe('until');
  expect(records.hits.some((h) => h.event === 'purchase')).toBe(false);
}, 60_000);

test('a timeout fails the step, and the record says so', async () => {
  const run = await play('{ text: Pay the test order, until: { url: "/thank-you*" }, timeout: 1s }');
  const error = await run.played.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StepError);
  expect((error as StepError).message).toContain('handoff did not reach /thank-you* within 1s');
  const { records } = await run.recorder.close();
  const step = payStep(records);
  expect(step.handoffEnd).toBe('timeout');
  expect(step.error).toContain('handoff did not reach /thank-you* within 1s');
}, 60_000);

test('Done still ends a handoff that has an until', async () => {
  const run = await play('{ text: Pay the test order, until: { url: "/thank-you*" }, timeout: 60s }');
  const box = await run.page.locator(`#${HANDOFF_HOST_ID}`).boundingBox();
  await run.page.mouse.click(box!.x + box!.width - 26, box!.y + box!.height / 2);
  await run.played;
  const { records } = await run.recorder.close();
  expect(payStep(records).handoffEnd).toBe('done');
  expect(run.printed.some((t) => t.startsWith('Handoff ended'))).toBe(false);
}, 60_000);
