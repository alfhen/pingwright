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
  outDir = await mkdtemp(join(tmpdir(), 'pw-dlframe-e2e-'));
});

afterAll(async () => {
  await site?.close();
  await rm(outDir, { recursive: true, force: true });
});

test('a dataLayer push records whether the main frame made it and a frame number', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  try {
    await recorder.visit(`${site.url}/datalayer-frame`);
    await recorder.wait(600);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  const top = records.dataLayerEvents.find((e) => e.event === 'top_push');
  const embedded = records.dataLayerEvents.find((e) => e.event === 'embedded_push');
  const top2 = records.dataLayerEvents.find((e) => e.event === 'top_push_2');
  const embedded2 = records.dataLayerEvents.find((e) => e.event === 'embedded_push_2');
  expect(top2).toBeDefined();
  expect(embedded2).toBeDefined();
  expect(top2!.frame).toEqual(top!.frame);
  expect(embedded2!.frame).toEqual(embedded!.frame);
  expect(top).toBeDefined();
  expect(embedded).toBeDefined();
  expect(top!.frame?.main).toBe(true);
  expect(embedded!.frame?.main).toBe(false);
  expect(embedded!.frame?.n).not.toBe(top!.frame?.n);
  for (const event of [top!, embedded!]) {
    expect(Object.keys(event.frame!).sort()).toEqual(['main', 'n']);
    const text = JSON.stringify({ ...event, args: undefined });
    expect(text).not.toContain('datalayer-frame');
    expect(text).not.toContain(site.url);
  }
}, 60_000);
