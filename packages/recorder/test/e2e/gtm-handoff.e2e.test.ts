import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchRecorder } from '../../src/index.ts';

const fakeAuth = 'pwfake-auth-0001';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'gtm-handoff-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('a container page loaded during a handoff window still gets the workspace build', async () => {
  process.env.PINGWRIGHT_TEST_GTM_ORIGIN = site.containerUrl;
  try {
    const recorder = await launchRecorder({
      networkMode: 'stub',
      outDir,
      site: site.url,
      gtmOverride: { container: 'GTM-PWTEST1', gtmAuth: fakeAuth, gtmPreview: 'env-99' },
    });
    recorder.setHandoff(true);
    await recorder.visit(`${site.url}/container/direct`);
    await recorder.wait(8000);
    recorder.setHandoff(false);
    const { records } = await recorder.close();
    expect(records.run.gtmOverride?.applied.map((a) => a.status)).toEqual([200]);
    expect(records.hits.some((h) => h.vendor === 'ga4' && h.event === 'workspace_only')).toBe(true);
  } finally {
    delete process.env.PINGWRIGHT_TEST_GTM_ORIGIN;
  }
}, 60_000);
