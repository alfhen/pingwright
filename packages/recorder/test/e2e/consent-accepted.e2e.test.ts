import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchRecorder } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'recorder-accepted-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const VENDOR_HOST = /(^|\.)(facebook\.com|facebook\.net|google\.com|googletagmanager\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com)$/;
const LIBRARY = /\/(gtag\/js|gtag\/destination|gtm\.js|fbevents\.js|signals\/config\/[^/?]*)(\?|$)/;

test('with consent accepted, every Meta and Google ad request except library loads is stubbed', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  await recorder.context.addCookies([{ name: 'pw_consent', value: 'accept', url: site.url }]);
  await recorder.visit(`${site.url}/`);
  await recorder.visit(`${site.url}/thank-you`);
  await recorder.wait(5000);
  const { records } = await recorder.close();

  const vendor = records.requests.filter((r) => VENDOR_HOST.test(new URL(r.url).hostname) && !LIBRARY.test(r.url));
  expect(vendor.length).toBeGreaterThan(0);
  expect(vendor.filter((r) => r.outcome !== 'stubbed').map((r) => `${r.outcome} ${r.resourceType} ${r.method} ${r.url}`)).toEqual([]);
  expect(vendor.some((r) => r.resourceType === 'script' && r.url.includes('/pagead/viewthroughconversion/'))).toBe(true);
});
