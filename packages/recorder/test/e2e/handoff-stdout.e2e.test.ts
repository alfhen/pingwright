import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@tagreeve/expect';
import { startFixtureSite, type FixtureSite } from '@tagreeve/fixture-site';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { HANDOFF_HOST_ID, launchRecorder, recordScenario } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'handoff-stdout-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('with no print, the handoff text goes to stderr and none of it to stdout', async () => {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  try {
    const parsed = parseScenario(
      'start: /handoff/until\nsteps:\n  - handoff: { text: Pay the test order, until: { url: "/thank-you-late" }, settle: 0s, timeout: 60s }\n    label: pay\n',
    );
    const launch: typeof launchRecorder = async (options) => {
      const recorder = await launchRecorder({ ...options, headed: false });
      void (async () => {
        await expect.poll(() => recorder.context.pages().length, { timeout: 20_000 }).toBe(1);
        const page = recorder.context.pages()[0]!;
        await page.waitForLoadState('load');
        await page.locator(`#${HANDOFF_HOST_ID}`).waitFor({ state: 'visible', timeout: 15_000 });
        await page.goto(new URL('/thank-you-late', site.url).href);
      })().catch(() => undefined);
      return recorder;
    };
    const { records } = await recordScenario({ networkMode: 'stub', outDir, site: site.url, scenario: 'handoff', parsed, launch });
    expect(records.steps.find((s) => s.label === 'pay')!.handoffEnd).toBe('until');
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  const stderrText = err.join('');
  expect(stderrText).toContain('Handoff: Pay the test order');
  expect(stderrText).toContain('Handoff ended: reached /thank-you-late');
  expect(stderrText).toContain('Press Enter when done.');
  const stdoutText = out.join('');
  expect(stdoutText).not.toContain('Handoff');
  expect(stdoutText).not.toContain('Press Enter');
  expect(stdoutText).not.toContain('Recording continues');
}, 90_000);
