import { createInterface } from 'node:readline/promises';
import { createIdentity, type Identity, type Request, type Step as StepRecord } from '@pingwright/core';
import { IDENTITY_FIELDS, SECRET_FIELD, type IdentityField, type Scenario, type Step } from '@pingwright/expect';
import type { Frame, Page } from 'playwright';
import { Scrubber } from './gtm-scrub.ts';
import { HANDOFF_REQUIRED, SENSITIVE_WRITE_TRAP, isLoopbackHost, isSensitiveField, type FieldAttributes } from './guard.ts';
import { waitForHandoff } from './handoff-overlay.ts';
import { launchRecorder, type Recorder, type RecorderOptions, type RunResult, type StepActivity } from './recorder.ts';

export type ConsentAnswer = Extract<Step, { kind: 'consent' }>['value'];

export interface ConsentContext {
  recorder: Recorder;
  page: Page;
  timeoutMs?: number;
}

export type ConsentHandler = (answer: ConsentAnswer, context: ConsentContext) => Promise<void>;

/** `withdraw` is a rejection; the scenario reopens the banner itself first. */
export const bannerConsentHandler: ConsentHandler = async (answer, { recorder, page, timeoutMs }) => {
  const result = await recorder.consent.answer(page, answer === 'withdraw' ? 'reject' : answer, timeoutMs ?? 10_000);
  if (result.result === 'banner not shown') {
    throw new Error(answer === 'withdraw' ? 'banner not shown (withdraw needs the banner reopened first)' : 'banner not shown');
  }
  if (result.result === 'failed') throw new Error(`consent ${answer} failed`);
  recorder.recordBanner(result);
};

/** Says whether the click of an `addToCart` step changed the cart, from what was recorded during the step. */
export type CartCheck = (activity: StepActivity) => boolean;

const CART_WRITE_PATH = /\/cart\/(?:add|change|update)(?:\.js)?(?:\/|$)|\/cart\/?$/i;
const CART_ADD_PATH = /\/cart\/add(?:\.js)?(?:\/|$)/i;
const CART_AJAX = /(?:^|[?&])wc-ajax=add_to_cart(?:&|$)/;
const CART_MUTATION = /cart(?:Create|LinesAdd)/;
const CART_EVENT = /^(?:add_to_cart|addToCart)$/i;

function isCartRequest(r: Request): boolean {
  const url = new URL(r.url);
  return (
    CART_AJAX.test(url.search) ||
    (r.method === 'GET' ? CART_ADD_PATH.test(url.pathname) : CART_WRITE_PATH.test(url.pathname) || CART_MUTATION.test(r.postData ?? ''))
  );
}

/**
 * A cart request (Shopify `/cart/add`, GET `/cart/add?id=`, Hydrogen POST `/cart`, Magento `/checkout/cart/add`,
 * WooCommerce `?wc-ajax=add_to_cart`, a Storefront cart mutation) or an add_to_cart dataLayer event.
 * A cart request counts once its response is recorded with a 2xx or 3xx status (a form POST answers with a redirect); a pending, failed, 4xx or 5xx one does not. `pattern` is a regular expression for URLs that also count.
 */
export function createCartCheck(pattern?: string): CartCheck {
  const custom = pattern === undefined ? undefined : new RegExp(pattern);
  return ({ requests, responses, dataLayerEvents }) => {
    const accepted = (r: Request): boolean => {
      const statuses = responses.filter((x) => x.requestId === r.id).map((x) => x.status);
      return statuses.some((status) => status >= 200 && status < 400);
    };
    return (
      dataLayerEvents.some((e) => e.event !== null && CART_EVENT.test(e.event)) ||
      requests.some((r) => (isCartRequest(r) || custom?.test(r.url) === true) && accepted(r))
    );
  };
}

export const defaultCartCheck: CartCheck = createCartCheck();

export interface PlayOptions {
  /** Identity seed. Default: the scenario's `options.seed`, else random. */
  seed?: number;
  consent?: ConsentHandler;
  /** Resolves when the person is done with a handoff. Default: waits for Enter on stdin. The Done control can end the wait first, and then the signal aborts. */
  handoffResolver?: (message: string, signal: AbortSignal) => Promise<void>;
  /** Where handoff instructions go. Default: stdout. */
  print?: (text: string) => void;
  /** Longest wait for a selector, a click or a fill. */
  actionTimeoutMs?: number;
  /** Decides whether an `addToCart` step added anything. Default: `defaultCartCheck`, widened by the scenario's `cartRequest`. */
  cartCheck?: CartCheck;
  /** How long an `addToCart` step waits for the cart check to pass. Default 5000. */
  cartTimeoutMs?: number;
}

export class StepError extends Error {
  /** Set by `recordScenario`: the run written up to the failure. */
  run?: RunResult;
  constructor(
    readonly label: string,
    message: string,
  ) {
    super(`step "${label}": ${message}`);
    this.name = 'StepError';
  }
}

/** The run finished and its JSONL is written, but the GTM override did not take effect. */
export class GtmOverrideFailure extends Error {
  constructor(
    message: string,
    readonly run: RunResult,
  ) {
    super(message);
    this.name = 'GtmOverrideFailure';
  }
}

const HANDOFF_REMINDER = 'Use test accounts and test cards only. Never enter real personal or payment details.';

export function hasHandoff(scenario: Scenario): boolean {
  return scenario.steps.some((s) => s.kind === 'handoff');
}

/** An identity field name gives the run's fake value; anything else is typed as written. */
export function fillValue(value: string, identity: Identity): string {
  return (IDENTITY_FIELDS as readonly string[]).includes(value) ? identity[value as IdentityField] : value;
}

export function resolveSitePath(path: string, site: string, vars: Record<string, string>): string {
  const base = new URL(site);
  const filled = path.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? `{${name}}`);
  const url = new URL(filled, base);
  if (url.origin !== base.origin) throw new Error(`"${path}" leaves the site ${base.origin}`);
  return url.href;
}

async function stdinResolver(_message: string, signal: AbortSignal): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press Enter when done. ', { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    rl.close();
  }
}

async function activePage(recorder: Recorder): Promise<Page> {
  const pages = recorder.context.pages();
  return pages[pages.length - 1] ?? recorder.context.newPage();
}

/** Returns true when the field is a card or password field (only allowed on loopback hosts). */
async function fillField(page: Page, selector: string, value: string, timeout: number): Promise<boolean> {
  const field = page.locator(selector).first();
  const inspected = await field.evaluate(
    (el): { tag: string; host: string; fields: FieldAttributes[] } => {
      const describe = (e: Element): FieldAttributes => ({
        autocomplete: e.getAttribute('autocomplete'),
        name: e.getAttribute('name'),
        id: e.getAttribute('id'),
        type: e.getAttribute('type'),
      });
      // Playwright retargets fill from a label to the control it labels, so that control is checked too.
      const isControl = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
      const labelled = el instanceof HTMLLabelElement ? el : isControl || (el as HTMLElement).isContentEditable ? null : el.closest('label');
      const control = labelled?.control ?? null;
      return {
        tag: (control ?? el).tagName.toLowerCase(),
        host: el.ownerDocument.location.hostname,
        fields: control ? [describe(el), describe(control)] : [describe(el)],
      };
    },
    undefined,
    { timeout },
  );
  if (inspected.fields.some(isSensitiveField) && !isLoopbackHost(inspected.host)) {
    throw new Error(`${selector} is a card or password field. ${HANDOFF_REQUIRED}`);
  }
  if (inspected.tag === 'select') await field.selectOption(value, { timeout });
  else await field.fill(value, { timeout });
  return inspected.fields.some(isSensitiveField);
}

interface PageField extends FieldAttributes {
  index: number;
  value: string;
  initial: string;
}

function hostedFrames(page: Page): Frame[] {
  return page.frames().filter((frame) => !isLoopbackHost(new URL(frame.url() || 'about:blank', 'http://invalid.invalid').hostname));
}

/** Remembers each field's value per element, so a field the script adds or moves is not compared with another one. */
async function rememberFieldValues(frame: Frame): Promise<void> {
  await frame
    .evaluate(() => {
      const initial = new WeakMap<Element, string>();
      for (const e of document.querySelectorAll('input, textarea')) initial.set(e, (e as HTMLInputElement).value);
      (window as unknown as { __pingwrightInitial: WeakMap<Element, string> }).__pingwrightInitial = initial;
    })
    .catch(() => undefined);
}

async function changedSensitiveFields(frame: Frame): Promise<PageField[]> {
  const fields = await frame
    .evaluate((): PageField[] => {
      const initial = (window as unknown as { __pingwrightInitial?: WeakMap<Element, string> }).__pingwrightInitial;
      delete (window as unknown as { __pingwrightInitial?: unknown }).__pingwrightInitial;
      return [...document.querySelectorAll('input, textarea')].map((e, index) => ({
        autocomplete: e.getAttribute('autocomplete'),
        name: e.getAttribute('name'),
        id: e.getAttribute('id'),
        type: e.getAttribute('type'),
        index,
        value: (e as HTMLInputElement).value,
        initial: initial ? (initial.get(e) ?? '') : (e as HTMLInputElement).defaultValue,
      }));
    })
    .catch(() => [] as PageField[]);
  return fields.filter((field) => isSensitiveField(field) && field.value !== '' && field.value !== field.initial);
}

/**
 * An evaluate step is no way around the guard. Card and password fields in hosted frames refuse
 * plain writes (value, defaultValue, setAttribute, setAttributeNS, Attr.value) while the script runs, and the step fails.
 * This is a guard, not a sandbox: a script that works around it (HTML parsing, another realm, async writes,
 * execCommand, setRangeText, redefining the setters) can still send a value.
 */
async function evaluateGuarded(page: Page, script: string): Promise<void> {
  const hosted = hostedFrames(page);
  const trapped: Frame[] = [];
  for (const frame of hosted) {
    if (await frame.evaluate(SENSITIVE_WRITE_TRAP).then(() => true, () => false)) trapped.push(frame);
    await rememberFieldValues(frame);
  }
  let scriptError: unknown;
  try {
    await page.evaluate(script);
  } catch (error) {
    scriptError = error;
  }
  let blocked = false;
  for (const frame of trapped) {
    const hit = await frame
      .evaluate(() => {
        const trap = (window as unknown as { __pingwrightTrap: { state: { blocked: boolean }; release: () => void } }).__pingwrightTrap;
        trap.release();
        return trap.state.blocked;
      })
      .catch(() => false);
    blocked ||= hit;
  }
  const changed: { frame: Frame; index: number }[] = [];
  for (const frame of hostedFrames(page)) {
    for (const { index } of await changedSensitiveFields(frame)) changed.push({ frame, index });
  }
  for (const { frame, index } of changed) {
    await frame.evaluate((i) => ((document.querySelectorAll('input, textarea')[i] as HTMLInputElement).value = ''), index).catch(() => undefined);
  }
  if (blocked || changed.length > 0) throw new Error(`the script set a card or password field. ${HANDOFF_REQUIRED}`);
  if (scriptError) throw scriptError;
}

async function waitForCart(recorder: Recorder, record: StepRecord, scenario: Scenario, options: PlayOptions): Promise<void> {
  const check = options.cartCheck ?? createCartCheck(scenario.options.cartRequest);
  const deadline = Date.now() + (options.cartTimeoutMs ?? 5000);
  while (!check(recorder.stepActivity(record))) {
    if (Date.now() >= deadline) throw new Error('click did not add to cart');
    await recorder.wait(100);
  }
}

async function runStep(
  step: Step,
  recorder: Recorder,
  scenario: Scenario,
  identity: Identity,
  options: PlayOptions,
  record: StepRecord,
): Promise<void> {
  const timeout = options.actionTimeoutMs ?? 30_000;
  const page = await activePage(recorder);
  switch (step.kind) {
    case 'visit':
      await page.goto(resolveSitePath(step.value, recorder.site, scenario.vars), { waitUntil: 'load', timeout });
      return;
    case 'click':
      await page.locator(step.value).first().click({ timeout });
      return;
    case 'addToCart':
      await page.locator(step.value).first().click({ timeout });
      await waitForCart(recorder, record, scenario, options);
      return;
    case 'fill':
      for (const [selector, value] of Object.entries(step.value)) {
        const typed = fillValue(value, identity);
        const sensitive = await fillField(page, selector, typed, timeout);
        if (sensitive || SECRET_FIELD.test(selector) || typed !== value) continue;
        identity.extra = [...new Set([...(identity.extra ?? []), typed])];
        recorder.setIdentity(identity);
      }
      return;
    case 'wait':
      if (typeof step.value === 'number') await recorder.wait(step.value);
      else await page.locator(step.value.selector).first().waitFor({ state: 'attached', timeout });
      return;
    case 'evaluate':
      await evaluateGuarded(page, step.value);
      return;
    case 'checkpoint':
      await recorder.checkpoint(step.value, record);
      return;
    case 'consent':
      await (options.consent ?? bannerConsentHandler)(step.value, { recorder, page, timeoutMs: scenario.options.consentTimeout });
      return;
    case 'handoff': {
      const print = options.print ?? ((text: string) => process.stdout.write(`${text}\n`));
      print(`\nHandoff: ${step.value}\n${HANDOFF_REMINDER}\nRecording continues until you are done.`);
      recorder.setHandoff(true);
      try {
        await waitForHandoff({ text: step.value, gate: recorder.handoff, resolver: options.handoffResolver ?? stdinResolver, print });
      } finally {
        recorder.setHandoff(false);
      }
      return;
    }
  }
}

/** The seeded identity with the scenario's own field values. Literal `fill` values join `extra` once typed into a non-sensitive field. */
export function scenarioIdentity(scenario: Scenario, seed: number): Identity {
  return { ...createIdentity(seed), ...scenario.identity };
}

/**
 * Plays the scenario's start visit, recorded as step 0 labelled "start", and then its steps.
 * The first failing step ends the run with a StepError.
 */
export async function playScenario(recorder: Recorder, scenario: Scenario, options: PlayOptions = {}): Promise<Identity> {
  const identity = scenarioIdentity(scenario, options.seed ?? scenario.options.seed ?? Math.floor(Math.random() * 2 ** 31));
  recorder.setIdentity(identity);
  const steps: Step[] = [{ kind: 'visit', value: scenario.start, label: 'start', line: 0 }, ...scenario.steps];
  for (const [index, step] of steps.entries()) {
    const record = recorder.beginStep(step.label, index);
    try {
      await runStep(step, recorder, scenario, identity, options, record);
      if (step.kind !== 'checkpoint') await recorder.checkpoint(step.label, record);
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0]! : String(error);
      recorder.endStep(record, message);
      throw new StepError(step.label, message);
    }
    recorder.endStep(record);
  }
  return identity;
}

export interface RecordScenarioOptions extends RecorderOptions, PlayOptions {
  parsed: Scenario;
  /** Test hook. Default: `launchRecorder`. */
  launch?: typeof launchRecorder;
}

/** Launches a recorder, headed when asked or when the scenario has a handoff, plays the scenario and writes the run. */
export async function recordScenario(options: RecordScenarioOptions): Promise<RunResult> {
  const { parsed, launch = launchRecorder, ...rest } = options;
  const recorder = await launch({ ...rest, headed: rest.headed || hasHandoff(parsed), handoffOverlay: hasHandoff(parsed) });
  try {
    await playScenario(recorder, parsed, rest);
  } catch (error) {
    const result = await recorder.close().catch(() => undefined);
    if (error instanceof StepError) {
      if (result) error.run = result;
      if (rest.gtmOverride) {
        const scrubber = new Scrubber(rest.gtmOverride.gtmAuth);
        error.message = scrubber.text(error.message);
        if (error.stack) error.stack = scrubber.text(error.stack);
      }
    }
    throw error;
  }
  const result = await recorder.close();
  if (result.gtmOverrideFailure) throw new GtmOverrideFailure(result.gtmOverrideFailure, result);
  return result;
}
