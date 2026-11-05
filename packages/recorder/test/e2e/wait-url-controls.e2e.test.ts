import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '@tagreeve/expect';
import { startFixtureSite, type FixtureSite } from '@tagreeve/fixture-site';
import type { Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchRecorder, playScenario } from '../../src/index.ts';
import { blockingControls } from '../../src/locators.ts';

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

test('each signal is read from the real page and no value, placeholder, error text or email is printed', async () => {
  const values: Record<string, string> = {};
  let cityMessage = '';
  const error = await failureOf('/terms-fields', async (page) => {
    for (const name of ['email', 'city', 'region', 'postcode', 'street', 'state', 'suburb', 'town']) values[name] = await page.inputValue(`[name=${name}]`);
    cityMessage = await page.$eval('[name=city]', (e) => (e as HTMLInputElement).validationMessage);
  });
  expect(values).toEqual({
    email: FAKE_EMAIL,
    city: 'Fakeville',
    region: 'Fakeregion',
    postcode: 'Fakepost',
    street: 'Fakestreet',
    state: 'Fakestate',
    suburb: 'Fakesuburb',
    town: 'Faketown',
  });
  expect(cityMessage).not.toBe('');
  expect(error).not.toContain(cityMessage);
  expect(error).toContain(
    'Blocking controls: email "Email" (aria-invalid), text "City" (invalid), text "Region" (aria-invalid), text "Postcode" (invalid), text "Street" (aria-invalid), checkbox "Send me the newsletter" (required, not ticked), text "State" (invalid), text "Suburb" (invalid), text "Town" (invalid), checkbox "I accept the terms" (required, not ticked).',
  );
  const forbidden = [
    ...Object.values(values),
    'Your city',
    'Your region',
    'Fakeville is invalid',
    'Fakeregion is not a region',
    'Fakepost is wrong',
    'Fakestreet is rejected',
    'Fakenews is required',
    'Fakenews is wrong',
    'Fakestate is unknown',
    'Fakesuburb is unknown',
    'Faketown is invalid',
    'Nickname',
    'Disabled terms',
    'token',
  ];
  for (const secret of forbidden) expect(error).not.toContain(secret);
});

const GUARD_CASES: { name: string; html: string; expected: string; forbidden: string }[] = [
  {
    name: 'select and option',
    html: '<label>Country <select name="c" required><option value="">Choose a country</option><option value="f">Fakeland</option></select></label>',
    expected: 'select "Country" (invalid)',
    forbidden: 'Fakeland',
  },
  { name: 'textarea', html: '<label>Notes <textarea name="n" aria-invalid="true">Faketext</textarea></label>', expected: 'textarea "Notes" (aria-invalid)', forbidden: 'Faketext' },
  { name: 'script', html: '<label>Script <script>var fakescript = 1</script><input name="s" aria-invalid="true"></label>', expected: 'text "Script" (aria-invalid)', forbidden: 'fakescript' },
  { name: 'style', html: '<label>Style <style>.fakestyle { color: red }</style><input name="y" aria-invalid="true"></label>', expected: 'text "Style" (aria-invalid)', forbidden: 'fakestyle' },
  { name: 'aria-live', html: '<label>Live <input name="l" aria-invalid="true"> <span aria-live="polite">Fakelive is wrong</span></label>', expected: 'text "Live" (aria-invalid)', forbidden: 'Fakelive' },
  { name: '.invalid-feedback', html: '<label>Feedback <input name="f" aria-invalid="true"> <div class="invalid-feedback">Fakefeedback is wrong</div></label>', expected: 'text "Feedback" (aria-invalid)', forbidden: 'Fakefeedback' },
  { name: '.field-error', html: '<label>Fielderr <input name="e" aria-invalid="true"> <span class="field-error">Fakefielderr is wrong</span></label>', expected: 'text "Fielderr" (aria-invalid)', forbidden: 'Fakefielderr' },
  {
    name: '.field__message--error',
    html: '<label>Message <input name="m" aria-invalid="true"> <span class="field__message--error">Fakemessage is wrong</span></label>',
    expected: 'text "Message" (aria-invalid)',
    forbidden: 'Fakemessage',
  },
  {
    name: 'a separate error label that is an aria-describedby target',
    html: '<input id="jq" name="jq" aria-invalid="true" aria-describedby="jq-error"><label for="jq">Region</label> <label id="jq-error" for="jq" class="error">Fakejq is not a region</label>',
    expected: 'text "Region" (aria-invalid)',
    forbidden: 'Fakejq',
  },
  {
    name: 'an aria-labelledby source that is itself role=status',
    html: '<input name="ls" aria-invalid="true" aria-labelledby="ls-name ls-status"><span id="ls-name">Phone</span> <span id="ls-status" role="status">Fakels is wrong</span>',
    expected: 'text "Phone" (aria-invalid)',
    forbidden: 'Fakels',
  },
  {
    name: 'an aria-labelledby source that is an output',
    html: '<input name="lo" aria-invalid="true" aria-labelledby="lo-name lo-out"><span id="lo-name">Fax</span> <output id="lo-out">Fakelo is wrong</output>',
    expected: 'text "Fax" (aria-invalid)',
    forbidden: 'Fakelo',
  },
  { name: 'aria-label name', html: '<input aria-label="Accept the privacy policy" type="checkbox" required>', expected: 'checkbox "Accept the privacy policy" (required, not ticked)', forbidden: 'Fakenothing' },
  { name: 'name attribute fallback', html: '<input name="promo_code" aria-invalid="true">', expected: 'text "promo_code" (aria-invalid)', forbidden: 'Fakenothing' },
];

test.each(GUARD_CASES)('name guard: $name', async ({ html, expected, forbidden }) => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  try {
    const page = await recorder.context.newPage();
    await page.setContent(`<!doctype html><body><form>${html}</form></body>`);
    const listed = await blockingControls(recorder.context);
    expect(listed).toEqual([expected]);
    expect(listed.join(' ')).not.toContain(forbidden);
  } finally {
    await recorder.close().catch(() => undefined);
  }
});
