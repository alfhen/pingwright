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
  outDir = await mkdtemp(join(tmpdir(), 'pw-dltally-e2e-'));
});

afterAll(async () => {
  await site?.close();
  await rm(outDir, { recursive: true, force: true });
});

interface Seen {
  pwOwnPushes: number;
  length: number;
  rawLength: number;
  token: string;
}

async function runPages(queries: string[]) {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  const seen: Seen[] = [];
  try {
    const page = await recorder.visit(`${site.url}/datalayer-theme${queries[0]}`);
    for (const [index, query] of queries.entries()) {
      if (index > 0) await page.goto(`${site.url}/datalayer-theme${query}`, { waitUntil: 'load' });
      await recorder.wait(300);
      seen.push(
        await page.evaluate(() => {
          const w = window as unknown as { pwOwnPushes: number; dataLayer: unknown[]; pwRaw: unknown[]; __tagreeveTally: () => { d: string } };
          return { pwOwnPushes: w.pwOwnPushes, length: w.dataLayer.length, rawLength: w.pwRaw.length, token: w.__tagreeveTally().d };
        }),
      );
    }
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const closed = await recorder.close();
  const flags = closed.records.flags.filter((f) => f.kind === 'dataLayerIncomplete');
  return { records: closed.records, flags, seen };
}

function expectNoLeak(records: { dataLayerEvents: unknown[] }, flags: { detail: string }[]) {
  const pushes = JSON.stringify(records.dataLayerEvents);
  if (records.dataLayerEvents.length > 0) {
    expect(pushes).toContain('pw-planted-value-1');
    expect(pushes).toContain('https://planted.example.test/x');
  }
  for (const flag of flags) {
    expect(flag.detail).not.toContain('pw-planted-value-1');
    expect(flag.detail).not.toContain('planted.example.test');
    expect(flag.detail).not.toContain(site.url);
  }
}

test('mode=redefine gives one flag for the main frame that says 3 items', async () => {
  const { records, flags, seen } = await runPages(['?mode=redefine']);
  expect(seen[0]).toMatchObject({ pwOwnPushes: 3, length: 3 });
  expect(flags).toHaveLength(1);
  expect(flags[0]!.detail).toMatch(/^Frame \d+: dataLayer holds 3 items, and 0 were recorded\./);
  expect(records.dataLayerEvents).toHaveLength(0);
  expectNoLeak(records, flags);
}, 60_000);

test('mode=theme is never silent: it records the 8 pushes or gives one flag that says 8 items', async () => {
  const { records, flags, seen } = await runPages(['?mode=theme']);
  expect(seen[0]).toMatchObject({ pwOwnPushes: 8, length: 8 });
  const main = records.dataLayerEvents.filter((e) => e.frame?.main);
  if (flags.length === 0) {
    expect(main).toHaveLength(8);
  } else {
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toMatch(/^Frame \d+: dataLayer holds 8 items, and \d+ were recorded\./);
  }
  expectNoLeak(records, flags);
}, 60_000);

test('mode=plain records its 3 pushes and gives no flag', async () => {
  const { records, flags, seen } = await runPages(['?mode=plain']);
  expect(seen[0]).toMatchObject({ pwOwnPushes: 3, length: 3 });
  expect(records.dataLayerEvents).toHaveLength(3);
  expect(flags).toEqual([]);
  expectNoLeak(records, flags);
}, 60_000);

test('a plain page that navigates in the same frame to a theme page is judged on the second document', async () => {
  const { records, flags, seen } = await runPages(['?mode=plain&n=10', '?mode=theme&n=8']);
  expect(seen[0]).toMatchObject({ pwOwnPushes: 10, length: 10 });
  expect(seen[1]).toMatchObject({ pwOwnPushes: 8, length: 8 });
  expect(seen[1]!.token).not.toBe(seen[0]!.token);
  const recorded = records.dataLayerEvents.length;
  if (flags.length === 1) {
    expect(recorded).toBe(10);
    expect(flags[0]!.detail).toContain('holds 8 items, and 0 were recorded');
  } else {
    expect(flags).toEqual([]);
    expect(recorded).toBe(18);
  }
  expectNoLeak(records, flags);
}, 60_000);

test('a plain page that navigates to an unshift page is flagged for the edit that no hook records', async () => {
  const { records, flags, seen } = await runPages(['?mode=plain&n=10', '?mode=unshift&n=3']);
  expect(seen[1]).toMatchObject({ pwOwnPushes: 4, length: 4 });
  expect(seen[1]!.token).not.toBe(seen[0]!.token);
  expect(records.dataLayerEvents).toHaveLength(11);
  expect(flags).toHaveLength(1);
  expect(flags[0]!.detail).toContain('holds 4 items, and 1 were recorded');
  expectNoLeak(records, flags);
}, 60_000);

test('two plain pages in one frame record 8 pushes and give no flag', async () => {
  const { records, flags } = await runPages(['?mode=plain&n=5', '?mode=plain&n=3']);
  expect(records.dataLayerEvents).toHaveLength(8);
  expect(flags).toEqual([]);
}, 60_000);
