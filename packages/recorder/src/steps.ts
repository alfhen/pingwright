import { createInterface } from 'node:readline/promises';
import { createIdentity, type Identity, type Step as StepRecord } from '@pingwright/core';
import type { Scenario, Step } from '@pingwright/expect';
import type { Page } from 'playwright';
import { HANDOFF_REQUIRED, isLoopbackHost, isSensitiveField, type FieldAttributes } from './guard.ts';
import { launchRecorder, type Recorder, type RecorderOptions, type RunResult } from './recorder.ts';

export type ConsentAnswer = Extract<Step, { kind: 'consent' }>['value'];

export interface ConsentContext {
  recorder: Recorder;
  page: Page;
}

export type ConsentHandler = (answer: ConsentAnswer, context: ConsentContext) => Promise<void>;

export const unwiredConsentHandler: ConsentHandler = () => {
  throw new Error('consent step not wired');
};

export interface PlayOptions {
  /** Identity seed. Default: the scenario's `options.seed`, else random. */
  seed?: number;
  consent?: ConsentHandler;
  /** Resolves when the person is done with a handoff. Default: waits for Enter on stdin. */
  handoffResolver?: (message: string) => Promise<void>;
  /** Where handoff instructions go. Default: stdout. */
  print?: (text: string) => void;
  /** Longest wait for a selector, a click or a fill. */
  actionTimeoutMs?: number;
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

const IDENTITY_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'zip', 'country'] as const;
type IdentityField = (typeof IDENTITY_FIELDS)[number];
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

async function stdinResolver(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question('Press Enter when done. ');
  } finally {
    rl.close();
  }
}

async function activePage(recorder: Recorder): Promise<Page> {
  const pages = recorder.context.pages();
  return pages[pages.length - 1] ?? recorder.context.newPage();
}

async function fillField(page: Page, selector: string, value: string, timeout: number): Promise<void> {
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
        tag: el.tagName.toLowerCase(),
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
    case 'addToCart':
      await page.locator(step.value).first().click({ timeout });
      return;
    case 'fill':
      for (const [selector, value] of Object.entries(step.value)) await fillField(page, selector, fillValue(value, identity), timeout);
      return;
    case 'wait':
      if (typeof step.value === 'number') await recorder.wait(step.value);
      else await page.locator(step.value.selector).first().waitFor({ state: 'attached', timeout });
      return;
    case 'evaluate':
      await page.evaluate(step.value);
      return;
    case 'checkpoint':
      await recorder.checkpoint(step.value, record);
      return;
    case 'consent':
      await (options.consent ?? unwiredConsentHandler)(step.value, { recorder, page });
      return;
    case 'handoff': {
      const print = options.print ?? ((text: string) => process.stdout.write(`${text}\n`));
      print(`\nHandoff: ${step.value}\n${HANDOFF_REMINDER}\nRecording continues until you are done.`);
      await (options.handoffResolver ?? stdinResolver)(step.value);
      return;
    }
  }
}

/**
 * Plays the scenario's start visit, recorded as step 0 labelled "start", and then its steps.
 * The first failing step ends the run with a StepError.
 */
export async function playScenario(recorder: Recorder, scenario: Scenario, options: PlayOptions = {}): Promise<Identity> {
  const identity = createIdentity(options.seed ?? scenario.options.seed ?? Math.floor(Math.random() * 2 ** 31));
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

export interface RecordScenarioOptions extends Omit<RecorderOptions, 'headed'>, PlayOptions {
  parsed: Scenario;
}

/** Launches a recorder, headed when the scenario has a handoff, plays the scenario and writes the run. */
export async function recordScenario(options: RecordScenarioOptions): Promise<RunResult> {
  const { parsed, ...rest } = options;
  const recorder = await launchRecorder({ ...rest, headed: hasHandoff(parsed) });
  try {
    await playScenario(recorder, parsed, rest);
  } catch (error) {
    const result = await recorder.close().catch(() => undefined);
    if (error instanceof StepError && result) error.run = result;
    throw error;
  }
  return recorder.close();
}
