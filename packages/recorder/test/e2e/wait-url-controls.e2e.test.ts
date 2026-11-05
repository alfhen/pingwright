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

test('an unticked required checkbox is named by its name attribute', async () => {
  expect(await failureOf('/terms-required')).toContain('Blocking controls: checkbox "terms" (required, not ticked).');
});

test('a control that the page marks aria-invalid after Pay is named', async () => {
  expect(await failureOf('/terms-aria-invalid')).toContain('Blocking controls: checkbox "terms" (aria-invalid).');
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
    'Blocking controls: email "email" (aria-invalid), text "city" (invalid), text "region" (aria-invalid), text "postcode" (invalid), text "street" (aria-invalid), checkbox "news" (required, not ticked), text "state" (invalid), text "suburb" (invalid), text "town" (invalid), checkbox "accept_terms" (required, not ticked).',
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
    'nickname',
    'disabled_terms',
    'token',
  ];
  for (const secret of forbidden) expect(error).not.toContain(secret);
});

const GUARD_CASES: { name: string; html: string; expected: string | string[]; forbidden: string }[] = [
  { name: 'aria-live', html: '<label>Live <input name="l" aria-invalid="true"> <span aria-live="polite">Fakelive is wrong</span></label>', expected: 'text "l" (aria-invalid)', forbidden: 'Fakelive' },
  { name: '.invalid-feedback', html: '<label>Feedback <input name="f" aria-invalid="true"> <div class="invalid-feedback">Fakefeedback is wrong</div></label>', expected: 'text "f" (aria-invalid)', forbidden: 'Fakefeedback' },
  { name: '.field-error', html: '<label>Fielderr <input name="e" aria-invalid="true"> <span class="field-error">Fakefielderr is wrong</span></label>', expected: 'text "e" (aria-invalid)', forbidden: 'Fakefielderr' },
  {
    name: '.field__message--error',
    html: '<label>Message <input name="m" aria-invalid="true"> <span class="field__message--error">Fakemessage is wrong</span></label>',
    expected: 'text "m" (aria-invalid)',
    forbidden: 'Fakemessage',
  },
  {
    name: 'a separate error label that is an aria-describedby target',
    html: '<input id="jq" name="jq" aria-invalid="true" aria-describedby="jq-error"><label for="jq">Region</label> <label id="jq-error" for="jq" class="error">Fakejq is not a region</label>',
    expected: 'text "jq" (aria-invalid)',
    forbidden: 'Fakejq',
  },
  {
    name: 'an aria-labelledby source that is itself role=status',
    html: '<input name="ls" aria-invalid="true" aria-labelledby="ls-name ls-status"><span id="ls-name">Phone</span> <span id="ls-status" role="status">Fakels is wrong</span>',
    expected: 'text "ls" (aria-invalid)',
    forbidden: 'Fakels',
  },
  {
    name: 'an aria-labelledby source that is an output',
    html: '<input name="lo" aria-invalid="true" aria-labelledby="lo-name lo-out"><span id="lo-name">Fax</span> <output id="lo-out">Fakelo is wrong</output>',
    expected: 'text "lo" (aria-invalid)',
    forbidden: 'Fakelo',
  },
  {
    name: 'a describedby error label with a framework class',
    html: '<label for="hb">Region</label><input id="hb" aria-invalid="true" aria-describedby="hb-error"><label id="hb-error" class="help-block" for="hb">Fakehb is not a region</label>',
    expected: 'text "hb" (aria-invalid)',
    forbidden: 'Fakehb',
  },
  {
    name: 'an aria-labelledby source that is a describedby target',
    html: '<input aria-invalid="true" aria-labelledby="ld-name ld-err" aria-describedby="ld-err"><span id="ld-name">Phone</span> <span id="ld-err">Fakeld is wrong</span>',
    expected: 'text (aria-invalid)',
    forbidden: 'Fakeld',
  },
  {
    name: 'a separate label that another element names in aria-describedby',
    html: '<div role="group" aria-describedby="g-err"><input id="g" aria-invalid="true"><label for="g">Gift</label> <label id="g-err" for="g">Fakeg is wrong</label></div>',
    expected: 'text "g" (aria-invalid)',
    forbidden: 'Fakeg',
  },
  {
    name: 'an aria-labelledby source that another element names in aria-describedby',
    html: '<input aria-invalid="true" aria-labelledby="n1 e1"><span id="n1">Phone</span> <span id="e1">Fakeo is wrong</span><input aria-describedby="e1">',
    expected: ['text (aria-invalid)'],
    forbidden: 'Fakeo',
  },
  {
    name: 'the only name source is the control own describedby target',
    html: '<input id="q1" name="q1" aria-invalid="true" aria-describedby="q1-error"><label id="q1-error" for="q1" class="help-block">Fakeq1 is not valid</label>',
    expected: 'text "q1" (aria-invalid)',
    forbidden: 'Fakeq1',
  },
  {
    name: 'the only labelledby source is the control own describedby target',
    html: '<input name="q2" aria-invalid="true" aria-labelledby="q2-err" aria-describedby="q2-err"><span id="q2-err">Fakeq2 is not valid</span>',
    expected: 'text "q2" (aria-invalid)',
    forbidden: 'Fakeq2',
  },
  {
    name: 'the only name source is the control own errormessage target',
    html: '<input id="q3" name="q3" aria-invalid="true" aria-errormessage="q3-error"><label id="q3-error" for="q3">Fakeq3 is not valid</label>',
    expected: 'text "q3" (aria-invalid)',
    forbidden: 'Fakeq3',
  },
  { name: '.invalid', html: '<label>Inv <input name="iv" aria-invalid="true"> <span class="invalid">Fakeinvalid is wrong</span></label>', expected: 'text "iv" (aria-invalid)', forbidden: 'Fakeinvalid' },
  {
    name: '.error-message',
    html: '<label>Em <input name="em" aria-invalid="true"> <span class="error-message">Fakeem is wrong</span></label>',
    expected: 'text "em" (aria-invalid)',
    forbidden: 'Fakeem',
  },
  { name: 'aria-invalid descendant', html: '<label>Ai <input name="ai" aria-invalid="true"> <span aria-invalid="true">Fakeai</span></label>', expected: ['text "ai" (aria-invalid)', 'control (aria-invalid)'], forbidden: 'Fakeai' },
  {
    name: 'aria-errormessage descendant',
    html: '<label>Aem <input name="aem" aria-invalid="true"> <span aria-errormessage="zz">Fakeaem</span></label>',
    expected: 'text "aem" (aria-invalid)',
    forbidden: 'Fakeaem',
  },
  {
    name: 'a checkbox label that wraps a select, textarea, script, style, button and datalist',
    html: '<label><input type="checkbox" name="w" required> Accept <select><option>Fakeland</option></select><textarea>Faketext</textarea><script>var fakescript = 1</script><style>.fakestyle { color: red }</style><button>Fakebutton</button><datalist id="dl"><option>Fakeopt</option></datalist> terms</label>',
    expected: 'checkbox "w" (required, not ticked)',
    forbidden: 'Fake',
  },
  {
    name: 'a required checkbox with a separate error label (jQuery Validate)',
    html: '<input type="checkbox" id="t" name="t" required><label for="t">Terms</label><label id="t-error" class="error" for="t">Fakejqcheck is required</label>',
    expected: 'checkbox "t" (required, not ticked)',
    forbidden: 'Fakejqcheck',
  },
  {
    name: 'a required checkbox with an error label nested in its wrapping label',
    html: '<label><input type="checkbox" id="t2" name="t2" required> Terms <label id="t2-error" class="error" for="t2">Fakejqnest is required</label></label>',
    expected: 'checkbox "t2" (required, not ticked)',
    forbidden: 'Fakejqnest',
  },
  ...['<span role="alert">', '<span role="status">', '<span aria-live="polite">', '<output>', '<span aria-hidden="true">', '<div id="ev" class="invalid-feedback">'].map((open) => ({
    name: `a required checkbox whose label holds ${open}`,
    html: `<label><input type="checkbox" name="nc" required> I accept the terms ${open}Fakenested is required</${open.slice(1).split(/[ >]/)[0]}></label>`,
    expected: 'checkbox "nc" (required, not ticked)',
    forbidden: 'Fakenested',
  })),
  ...[
    ['span.error', '<span class="error">Fakespan is required</span>'],
    ['small.text-danger', '<small class="text-danger">Fakesmall is required</small>'],
    ['span#id', '<span id="x">Fakeid is required</span>'],
    ['span[hidden]', '<span hidden>Fakehidden is required</span>'],
    ['span[data-*]', '<span data-error="1">Fakedata is required</span>'],
  ].map(([n, inner]) => ({
    name: `a required unticked checkbox whose label holds ${n}`,
    html: `<label><input type="checkbox" name="pc" required> I accept the terms ${inner}</label>`,
    expected: 'checkbox "pc" (required, not ticked)',
    forbidden: 'Fake',
  })),
  {
    name: 'a lone jQuery Validate error label that is the describedby target',
    html: '<input type="checkbox" id="d" name="d" required aria-describedby="d-error"> <span>I accept</span> <label id="d-error" class="error" for="d">Fakejqonly is required</label>',
    expected: 'checkbox "d" (required, not ticked)',
    forbidden: 'Fakejqonly',
  },
  {
    name: 'a lone role=alert label that is the errormessage target',
    html: '<input type="checkbox" id="e" name="e" required aria-errormessage="e-err"> <label id="e-err" role="alert" for="e">Fakealertlabel is required</label>',
    expected: 'checkbox "e" (required, not ticked)',
    forbidden: 'Fakealertlabel',
  },
  {
    name: 'a lone aria-live label',
    html: '<input type="checkbox" id="f" name="f" required> <label for="f" aria-live="polite">Fakelivelabel is required</label>',
    expected: 'checkbox "f" (required, not ticked)',
    forbidden: 'Fakelivelabel',
  },
  {
    name: 'a required checkbox with aria-label and an error label',
    html: '<input type="checkbox" id="h" name="h" aria-label="Accept privacy" required aria-describedby="h-err"><label id="h-err" class="error" for="h">Fakearia is required</label>',
    expected: 'checkbox "Accept privacy" (required, not ticked)',
    forbidden: 'Fakearia',
  },
  { name: 'a disabled required field', html: '<label>Nick <input name="nick" required disabled></label>', expected: [] as string[], forbidden: 'nick' },
  { name: 'a disabled required checkbox', html: '<label><input type="checkbox" name="dt" required disabled> Disabled terms</label>', expected: [] as string[], forbidden: 'dt' },
  { name: 'a hidden aria-invalid input', html: '<input type="hidden" name="tok" aria-invalid="true">', expected: [] as string[], forbidden: 'tok' },
  {
    name: 'a wrapping label with an error class',
    html: '<label class="error">Terms <input type="checkbox" required></label>',
    expected: 'checkbox (required, not ticked)',
    forbidden: 'Terms',
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
    expect(listed).toEqual([expected].flat());
    expect(listed.join(' ')).not.toContain(forbidden);
  } finally {
    await recorder.close().catch(() => undefined);
  }
});

test('the name reader never clones a node', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  try {
    const page = await recorder.context.newPage();
    await page.setContent(
      '<!doctype html><body><form><label>Pic <m15-probe></m15-probe><input type="checkbox" required></label></form></body>',
    );
    await page.evaluate(() => {
      const w = window as unknown as { m15Clones: number };
      w.m15Clones = 0;
      customElements.define('m15-probe', class extends HTMLElement {
        constructor() {
          super();
          w.m15Clones += 1;
        }
      });
    });
    const before = await page.evaluate(() => (window as unknown as { m15Clones: number }).m15Clones);
    const listed = await blockingControls(recorder.context);
    expect(listed).toEqual(['checkbox (required, not ticked)']);
    expect(await page.evaluate(() => (window as unknown as { m15Clones: number }).m15Clones)).toBe(before);
  } finally {
    await recorder.close().catch(() => undefined);
  }
});
