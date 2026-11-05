import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    const page = await recorder.visit(`${site.url}/datalayer-frame`);
    await recorder.wait(600);
    const child = page.frames().find((f) => f !== page.mainFrame());
    expect(child).toBeDefined();
    await Promise.all([child!.waitForNavigation(), child!.evaluate(() => location.assign('/datalayer-frame-child?again=1'))]);
    await recorder.wait(600);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const closed = await recorder.close();
  const records = closed.records;
  const written = await readFile(closed.path, 'utf8');

  const top = records.dataLayerEvents.find((e) => e.event === 'top_push');
  const top2 = records.dataLayerEvents.find((e) => e.event === 'top_push_2');
  const embeddedPushes = records.dataLayerEvents.filter((e) => e.event === 'embedded_push');
  const embedded2 = records.dataLayerEvents.find((e) => e.event === 'embedded_push_2');
  expect(top).toBeDefined();
  expect(top2!.frame).toEqual(top!.frame);
  expect(embedded2).toBeDefined();
  expect(embeddedPushes).toHaveLength(2);
  const [before, after] = embeddedPushes;
  expect(after!.frame).toEqual(before!.frame);
  expect(embedded2!.frame).toEqual(before!.frame);
  expect(top!.frame?.main).toBe(true);
  expect(before!.frame?.main).toBe(false);
  expect(before!.frame?.n).not.toBe(top!.frame?.n);

  const lines = written.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; frame?: unknown });
  const writtenEvents = lines.filter((l) => l.type === 'dataLayerEvent');
  expect(writtenEvents.length).toBe(records.dataLayerEvents.length);
  for (const event of [...records.dataLayerEvents, ...writtenEvents]) {
    const text = JSON.stringify(event);
    expect(text).not.toContain('datalayer-frame');
    expect(text).not.toContain(site.url);
  }
  for (const event of [top!, ...embeddedPushes]) expect(Object.keys(event.frame!).sort()).toEqual(['main', 'n']);
}, 60_000);
