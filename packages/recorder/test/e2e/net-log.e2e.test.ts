import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { launchRecorder } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'pw-netlog-e2e-'));
});

afterAll(async () => {
  await site?.close();
  await rm(outDir, { recursive: true, force: true });
});

const netLogDirs = async () => (await readdir(tmpdir())).filter((n) => n.startsWith('pingwright-netlog-'));

test('the net log captures the unload hit of a sandboxed iframe on the fixture site', async () => {
  const before = await netLogDirs();
  const recorder = await launchRecorder({ networkMode: 'live', netLog: true, outDir, site: site.url });
  try {
    const page = await recorder.visit(`${site.url}/unload-beacons-bare`);
    await page.click('#add-to-cart');
    await recorder.wait(300);
    await recorder.visit(`${site.url}/unload-beacons-bare?next`);
    await recorder.wait(300);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  const fromLog = records.requests.filter((r) => r.captured === 'netlog');
  expect(fromLog.length).toBeGreaterThanOrEqual(1);
  expect(fromLog.some((r) => r.initiator === 'unload')).toBe(true);
  const hit = records.hits.find((h) => h.event === 'add_to_cart');
  expect(hit).toBeDefined();
  expect(fromLog.map((r) => r.id)).toContain(hit!.requestId);
  expect(records.flags.filter((f) => f.kind === 'netLogUnreadable')).toEqual([]);
  expect(await readdir(outDir)).not.toContainEqual(expect.stringMatching(/^netlog-/));
  expect(await netLogDirs()).toEqual(before);
}, 90_000);

test('netLog in stub mode is refused', async () => {
  await expect(launchRecorder({ networkMode: 'stub', netLog: true, outDir, site: site.url })).rejects.toThrow(/networkMode "live"/);
});
