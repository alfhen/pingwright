import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { decodeRequest } from '@pingwright/decoders';
import { launchRecorder } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  outDir = await mkdtemp(join(tmpdir(), 'pw-unload-body-e2e-'));
});

afterAll(async () => {
  await site?.close();
  await rm(outDir, { recursive: true, force: true });
});

test('a keepalive fetch built from a Request with a body keeps its body when sent on pagehide', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  try {
    const page = await recorder.visit(`${site.url}/unload-request-body`);
    await page.click('a');
    await page.waitForURL('**/?next');
    await recorder.wait(500);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  const sent = records.requests.filter((q) => q.url.startsWith('https://sgtm.pingwright.invalid/g/collect'));
  expect(sent).toHaveLength(1);
  expect(sent[0]!.method).toBe('POST');
  expect(sent[0]!.postData).toBe('en=add_to_cart&ep.via=request\nen=view_item&ep.via=request');
  expect(decodeRequest(sent[0]!).map((h) => h.event)).toEqual(['add_to_cart', 'view_item']);
}, 60_000);
