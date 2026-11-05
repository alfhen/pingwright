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
  outDir = await mkdtemp(join(tmpdir(), 'pw-dlwrap-e2e-'));
});

afterAll(async () => {
  await site?.close();
  await rm(outDir, { recursive: true, force: true });
});

async function load(query: string) {
  const previous = process.env.TAGREEVE_TEST_GTM_ORIGIN;
  process.env.TAGREEVE_TEST_GTM_ORIGIN = site.containerUrl;
  let ownPushes: unknown;
  let recorder;
  try {
    recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  } finally {
    if (previous === undefined) delete process.env.TAGREEVE_TEST_GTM_ORIGIN;
    else process.env.TAGREEVE_TEST_GTM_ORIGIN = previous;
  }
  try {
    const page = await recorder.visit(`${site.url}/datalayer-wrap${query}`);
    await recorder.wait(600);
    ownPushes = await page.evaluate(() => (window as unknown as { pwOwnPushes: number }).pwOwnPushes);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  const own = records.dataLayerEvents.filter((e) => ['before_loader', 'after_loader_1', 'after_loader_2'].includes(e.event ?? ''));
  return { records, own, ownPushes };
}

const names = ['before_loader', 'after_loader_1', 'after_loader_2'];

test('wrap=through records each push once and reads the id the loader sets after the call', async () => {
  const { records, own, ownPushes } = await load('?wrap=through');
  expect(ownPushes).toBe(3);
  expect(own.map((e) => e.event)).toEqual(names);
  expect(own[0]!.gtmUniqueEventId).toBeNull();
  expect(own[1]!.gtmUniqueEventId).not.toBeNull();
  expect(own[2]!.gtmUniqueEventId).not.toBeNull();
  expect(records.flags.filter((f) => f.kind === 'dataLayerReassigned')).toEqual([]);
}, 60_000);

test('wrap=drop still records the pushes after the wrapper', async () => {
  const { own, ownPushes } = await load('?wrap=drop');
  expect(ownPushes).toBe(3);
  expect(own.map((e) => e.event)).toEqual(names);
}, 60_000);

test('reassign adds one dataLayerReassigned flag and still records the new array', async () => {
  const { records, own, ownPushes } = await load('?reassign=1');
  expect(ownPushes).toBe(3);
  expect(own.map((e) => e.event)).toEqual(names);
  const flags = records.flags.filter((f) => f.kind === 'dataLayerReassigned');
  expect(flags).toHaveLength(1);
  expect(flags[0]!.detail).not.toContain('http');
}, 60_000);
