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
  let wrapRuns: unknown;
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
    wrapRuns = await page.evaluate(() => (window as unknown as { pwWrapRuns: number }).pwWrapRuns);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  const own = records.dataLayerEvents.filter((e) => ['before_loader', 'after_loader_1', 'after_loader_2'].includes(e.event ?? ''));
  return { records, own, ownPushes, wrapRuns };
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

test('wrap=drop does not record pushes the wrapper dropped, because they never reached the array', async () => {
  const { own, ownPushes } = await load('?wrap=drop');
  expect(ownPushes).toBe(3);
  expect(own.map((e) => e.event)).toEqual(['before_loader']);
}, 60_000);

test('wrap=native records pushes made through an assigned Array.prototype.push', async () => {
  const { own, ownPushes } = await load('?wrap=native');
  expect(ownPushes).toBe(3);
  expect(own.map((e) => e.event)).toEqual(names);
}, 60_000);

test('wrap=guard runs an identity-guarded wrapper once per push and records each push once', async () => {
  const { own, ownPushes, wrapRuns } = await load('?wrap=guard');
  expect(ownPushes).toBe(3);
  expect(wrapRuns).toBe(2);
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
