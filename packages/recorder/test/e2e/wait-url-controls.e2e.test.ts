import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@tagreeve/expect';
import { startFixtureSite, type FixtureSite } from '@tagreeve/fixture-site';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchRecorder, playScenario } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'wait-url-controls-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const FAKE_EMAIL = 'pw-fixture@example.com';

async function failureOf(path: string, valuesOf?: (page: Page) => Promise<void>): Promise<string> {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  try {
    const scenario = parseScenario(`start: ${path}\nsteps:\n  - click: { role: button, name: Pay now }\n  - wait: { url: "/thank-you*" }\n`);
    const error = await playScenario(recorder, scenario, { actionTimeoutMs: 2000 }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(error).not.toBe('');
    expect(error).not.toContain(FAKE_EMAIL);
    expect(error).not.toContain(encodeURIComponent(FAKE_EMAIL));
    if (valuesOf) await valuesOf(recorder.context.pages()[0]!);
    return error;
  } finally {
    await recorder.close().catch(() => undefined);
  }
}

test('an unticked required checkbox is named', async () => {
  expect(await failureOf('/terms-required')).toContain('Blocking controls: checkbox "I agree to the terms and conditions" (required, not ticked).');
});

test('a control that the page marks aria-invalid after Pay is named', async () => {
  expect(await failureOf('/terms-aria-invalid')).toContain('Blocking controls: checkbox "I agree to the terms and conditions" (aria-invalid).');
});

test('with no blocking control the message is the plain one', async () => {
  const error = await failureOf('/terms-none');
  expect(error).toMatch(/page did not reach \/thank-you\* within \S+$/);
  expect(error).not.toContain('Blocking controls');
});

test('each signal is read from the real page and no value, placeholder or email is printed', async () => {
  let cityValue = '';
  let regionValue = '';
  const error = await failureOf('/terms-fields', async (page) => {
    cityValue = await page.inputValue('[name=city]');
    regionValue = await page.inputValue('[name=region]');
  });
  expect(cityValue).toBe('Fakeville');
  expect(regionValue).toBe('Fakeregion');
  expect(error).toContain(
    'Blocking controls: text "Full name" (invalid), text "City" (invalid), text "Region" (aria-invalid), text "promo_code" (invalid), checkbox "Send me the newsletter" (required, not ticked), checkbox "Accept the privacy policy" (required, not ticked), select "Country" (invalid).',
  );
  for (const secret of ['Fakeville', 'Fakeregion', 'Your city', 'Your region', 'is invalid', 'is not a region', 'Choose a country', 'Fakeland', 'Nickname', 'token']) expect(error).not.toContain(secret);
});
