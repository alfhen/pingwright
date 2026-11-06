import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from '@tagreeve/fixture-site';
import { launchRecorder } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'pw-dltheme-e2e-'));
});

afterAll(async () => {
  await site?.close();
  await rm(outDir, { recursive: true, force: true });
});

const incomplete = (flags: { kind: string }[]) => flags.filter((f) => f.kind === 'dataLayerIncomplete');

test('mode=theme records the 8 pushes of a page that replaced push, in order, with no incomplete flag', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  let ownPushes: unknown;
  try {
    const page = await recorder.visit(`${site.url}/datalayer-theme?mode=theme`);
    await recorder.wait(300);
    ownPushes = await page.evaluate(() => (window as unknown as { pwOwnPushes: number }).pwOwnPushes);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  expect(ownPushes).toBe(8);
  const main = records.dataLayerEvents.filter((e) => e.frame?.main);
  expect(main).toHaveLength(8);
  expect(main[0]!.args.slice(0, 2)).toEqual(['consent', 'default']);
  expect(main.slice(1, 7).map((e) => e.event)).toEqual([1, 2, 3, 4, 5, 6].map((i) => `pw_item_${i}`));
  expect(main[7]!.args.slice(0, 2)).toEqual(['consent', 'update']);
  expect(incomplete(records.flags)).toEqual([]);
}, 60_000);

test('an item added through the saved raw array right before close is recorded by the close catch-up', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  let rawLength = 0;
  try {
    const page = await recorder.visit(`${site.url}/datalayer-theme?mode=theme`);
    await recorder.wait(300);
    rawLength = await page.evaluate(() => {
      const w = window as unknown as { pwRaw: unknown[] };
      Array.prototype.push.call(w.pwRaw, { event: 'pw_late_raw' });
      return w.pwRaw.length;
    });
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  expect(rawLength).toBe(9);
  const { records } = await recorder.close();
  const main = records.dataLayerEvents.filter((e) => e.frame?.main);
  expect(main).toHaveLength(9);
  expect(main[8]!.event).toBe('pw_late_raw');
  expect(incomplete(records.flags)).toEqual([]);
}, 60_000);
