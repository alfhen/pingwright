import type { Identity, Step as StepRecord } from '@tagreeve/core';
import { canonicalCard, findPaymentProvider, type PaymentProvider } from '@tagreeve/expect';
import type { ElementHandle, Frame, Page } from 'playwright';
import { isLoopbackHost } from './guard.ts';
import type { Recorder } from './recorder.ts';

type FieldKind = 'number' | 'expiry' | 'cvc' | 'name';

interface CardField {
  kind: FieldKind;
  /** The iframe element on the top page. */
  frame: string;
  /** The input inside that iframe. */
  input: string;
  /** The URL path the frame's document must have. */
  path: RegExp;
}

interface ProviderRuntime {
  /** Visible on the top page only when the provider is in test mode. */
  marker: string;
  /** The exact host every card frame must be served from. */
  cardHost: string;
  fields: CardField[];
}

const SHOPIFY_CARD_HOST = 'checkout.pci.shopifyinc.com';

const documentPath = (name: string): RegExp => new RegExp(`/${name}-(ltr|rtl)\\.html$`);

// Only number-ltr.html is confirmed on a real store (#788); the other suffixes follow the field names.
const shopifyFields: CardField[] = [
  { kind: 'number', frame: 'iframe[title*="Card number" i]', input: 'input[autocomplete="cc-number"], input[name="number"]', path: documentPath('number') },
  { kind: 'expiry', frame: 'iframe[title*="Expiration" i]', input: 'input[autocomplete="cc-exp"], input[name="expiry"]', path: documentPath('expiry') },
  { kind: 'cvc', frame: 'iframe[title*="Security code" i]', input: 'input[autocomplete="cc-csc"], input[name="verification_value"]', path: documentPath('verification_value') },
  { kind: 'name', frame: 'iframe[title*="Name on card" i]', input: 'input[autocomplete="cc-name"], input[name="name"]', path: documentPath('name') },
];

/** The fixture's older single-document and split pages, and Shopify-shaped documents. */
const fixturePath = (legacy: string, shopify: string): RegExp => new RegExp(`^/card-frame(-${legacy}|-extra-input)?$|/${shopify}-(ltr|rtl)\\.html$`);

const RUNTIME: Record<string, ProviderRuntime> = {
  'shopify-bogus': { marker: 'text=Bogus Gateway', cardHost: SHOPIFY_CARD_HOST, fields: shopifyFields },
  'shopify-test': { marker: 'text=/test mode/i', cardHost: SHOPIFY_CARD_HOST, fields: shopifyFields },
  fixture: {
    marker: '#pw-test-mode',
    cardHost: '127.0.0.1',
    fields: [
      { kind: 'number', frame: '#card-frame, #card-frame-number', input: 'input[autocomplete="cc-number"], input[name="number"]', path: fixturePath('number', 'number') },
      { kind: 'expiry', frame: '#card-frame, #card-frame-exp', input: 'input[autocomplete="cc-exp"], input[name="expiry"]', path: fixturePath('exp', 'expiry') },
      { kind: 'cvc', frame: '#card-frame, #card-frame-csc', input: 'input[autocomplete="cc-csc"], input[name="verification_value"]', path: fixturePath('csc', 'verification_value') },
    ],
  },
};

const MARKER_TIMEOUT_MS = 5000;

/** What the CLI hands to the run once gates 1 and 2 have passed. */
export interface TestPayment {
  /** The `--allow-test-payment` host. */
  host: string;
  /** Provider ids the user declared to be in test mode on this host. A declared provider skips the page marker. */
  declaredProviders?: readonly string[];
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '');
}

/** Gate 1 for one scenario step: the provider may run on this `--site` host. Returns the reason it may not. */
export function providerBlockedOnSite(providerId: string, siteHost: string): string | undefined {
  const provider = findPaymentProvider(providerId);
  if (!provider) return `unknown payment provider ${providerId}`;
  if (provider.loopbackOnly && !isLoopbackHost(normalizeHost(siteHost))) {
    return `the ${provider.id} test payment provider is only for loopback sites`;
  }
  return undefined;
}

function hostOf(url: string): string {
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

interface CardFrame {
  element: ElementHandle;
  frame: Frame;
}

/** The first matching iframe that is visible and whose document is served from the card host at the field's path, or the reason there is none. */
async function cardFrameServed(page: Page, field: CardField, cardHost: string, deadline: number): Promise<CardFrame | string> {
  let reason = 'not found';
  for (;;) {
    try {
      let hidden = false;
      let elsewhere = false;
      let otherPath: string | undefined;
      for (const element of await page.locator(field.frame).elementHandles()) {
        const frame = await element.contentFrame();
        if (!frame) continue;
        if (hostOf(frame.url()) !== cardHost) {
          elsewhere = true;
        } else if (!field.path.test(pathOf(frame.url()))) {
          otherPath = pathOf(frame.url());
        } else if (await element.isVisible()) {
          return { element, frame };
        } else {
          hidden = true;
        }
      }
      reason = hidden ? 'not visible' : otherPath !== undefined ? `served from another path: ${otherPath}` : elsewhere ? 'served from another host' : 'not found';
    } catch {
      return reason;
    }
    if (Date.now() >= deadline) return reason;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * The marker must sit inside the nearest element that holds every card frame, so merchant copy elsewhere on the page cannot pass.
 * The container starts at the first frame's parent: a frame's own document is not page text.
 */
async function markerInCardContainer(frames: ElementHandle[], marker: string, timeout: number): Promise<boolean> {
  try {
    const container = await frames[0]!.evaluateHandle((first, all) => {
      let node: Element | null = first.parentElement;
      while (node && !all.every((f) => node!.contains(f))) node = node.parentElement;
      return node;
    }, frames);
    const element = container.asElement();
    if (!element) return false;
    await element.waitForSelector(marker, { state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

function valueOf(kind: FieldKind, provider: PaymentProvider, card: string, identity: Identity): string {
  if (kind === 'number') return card;
  if (kind === 'expiry') return provider.expiry;
  if (kind === 'cvc') return provider.cvc;
  return `${identity.firstName} ${identity.lastName}`;
}

/**
 * Types a provider's documented test card into its card frames. It has its own path: it never calls the fill, select or evaluate guards.
 * Every check runs before the first key. Errors name the field, never a typed value.
 */
export async function runPayment(
  page: Page,
  recorder: Pick<Recorder, 'holdRedaction'>,
  value: { provider: string; card: string },
  identity: Identity,
  testPayment: TestPayment | undefined,
  record: StepRecord,
  timeout: number,
  siteHost: string,
): Promise<void> {
  const provider = findPaymentProvider(value.provider);
  const runtime = RUNTIME[value.provider];
  const card = provider ? canonicalCard(provider, value.card) : undefined;
  if (!provider || !runtime || card === undefined) throw new Error('payment step is not a documented test payment');
  if (!testPayment) throw new Error('test payments are not allowed in this run');
  const blocked = providerBlockedOnSite(provider.id, siteHost);
  if (blocked) throw new Error(blocked);
  const allowed = normalizeHost(testPayment.host);
  if (hostOf(page.url()) !== allowed || normalizeHost(siteHost) !== allowed) {
    throw new Error('test mode not detected (the page is not on the allowed test payment host)');
  }
  const declared = testPayment.declaredProviders?.includes(provider.id) === true;
  const wait = Math.min(timeout, MARKER_TIMEOUT_MS);
  const deadline = Date.now() + wait;
  const found: CardFrame[] = [];
  for (const field of runtime.fields) {
    const result = await cardFrameServed(page, field, runtime.cardHost, deadline);
    if (typeof result === 'string') throw new Error(`card frame not found (${field.kind}): ${result}`);
    found.push(result);
  }
  if (!declared && !(await markerInCardContainer(found.map((f) => f.element), runtime.marker, wait))) throw new Error('test mode not detected');
  recorder.holdRedaction();
  const typed = typedValues(provider, card, identity);
  for (const [index, field] of runtime.fields.entries()) {
    try {
      await fillVerified(found[index]!.element, field, runtime.cardHost, valueOf(field.kind, provider, card, identity), timeout, typed);
    } catch (error) {
      throw new Error(`card field ${field.kind} could not be filled: ${reasonOf(error, typed)}`);
    }
    if (index === 0) record.payment = { provider: provider.id, mode: 'test', testMode: declared ? 'declared' : 'marker' };
  }
}

const GONE_FRAME = 'the card frame is gone or not served from the card host';

async function frameStillServed(element: ElementHandle, cardHost: string, field: CardField): Promise<Frame> {
  const frame = await element.contentFrame();
  if (!frame || hostOf(frame.url()) !== cardHost || !field.path.test(pathOf(frame.url()))) {
    throw new OwnReason(GONE_FRAME);
  }
  return frame;
}

const FILL_TRY_MS = 500;

/**
 * Types into the one visible input of the frame that the frame check verified.
 * The input is resolved to an ElementHandle first and the host and path are checked after that. A handle belongs to the document it was resolved in,
 * so a navigation before the check leaves a handle on a document the check rejects, and a navigation after it detaches the handle and the fill fails.
 * Locator.fill would resolve again in whatever document arrives, so it never types.
 * Each fill is a short try inside the poll loop, so one long wait cannot outlive the check.
 */
async function fillVerified(element: ElementHandle, field: CardField, cardHost: string, value: string, timeout: number, typed: string[]): Promise<void> {
  const deadline = Date.now() + timeout;
  const tryMs = (): number => Math.max(1, Math.min(FILL_TRY_MS, deadline - Date.now()));
  for (;;) {
    const frame = await frameStillServed(element, cardHost, field);
    const inputs = frame.locator(field.input).filter({ visible: true });
    const count = await inputs.count();
    if (count === 1) {
      try {
        const handle = await inputs.elementHandle({ timeout: tryMs() });
        await frameStillServed(element, cardHost, field);
        await handle.fill(value, { timeout: tryMs() });
        return;
      } catch (error) {
        if (!(error instanceof Error && error.name === 'TimeoutError') || Date.now() >= deadline) throw error;
        continue;
      }
    }
    if (Date.now() >= deadline) {
      const current = await frameStillServed(element, cardHost, field).catch(() => undefined);
      throw new OwnReason(current ? await countReason(current, count, typed) : GONE_FRAME);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The frame's path and the name, autocomplete and type of each visible input. Never a value, a placeholder or a label. */
async function countReason(frame: Frame, count: number, typed: string[]): Promise<string> {
  const attribute = (v: string | null): string => scrub((v ?? '').replace(/\s+/g, ' '), typed).slice(0, 40);
  let inputs = ' none visible';
  try {
    const seen = await frame
      .locator('input')
      .filter({ visible: true })
      .evaluateAll((all) => all.map((e) => ({ name: e.getAttribute('name'), autocomplete: e.getAttribute('autocomplete'), type: e.getAttribute('type') })));
    if (seen.length > 0) inputs = seen.map((i) => ` [name=${attribute(i.name)} autocomplete=${attribute(i.autocomplete)} type=${attribute(i.type)}]`).join('');
  } catch {
    inputs = ' inputs not readable';
  }
  return `${count} visible inputs match in ${pathOf(frame.url())}:${inputs}`;
}

function typedValues(provider: PaymentProvider, card: string, identity: Identity): string[] {
  const values = [card, provider.expiry, provider.cvc, identity.firstName, identity.lastName, `${identity.firstName} ${identity.lastName}`];
  return values.filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}

/** A reason this file builds itself. It holds no typed value, so the scrubber leaves it alone. */
class OwnReason extends Error {}

/**
 * The first line of the error, with every typed value removed.
 * Only values shorter than 4 characters (the test card `1`, a CVC) are matched on digit boundaries, so they don't eat digits of other numbers.
 * Longer values are removed wherever they appear, even next to a digit.
 */
function reasonOf(error: unknown, typed: string[]): string {
  if (error instanceof OwnReason) return error.message;
  return scrub((error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '', typed) || 'unknown error';
}

function scrub(text: string, typed: string[]): string {
  const pattern = (value: string): RegExp => {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(value.length < 4 ? `(?<!\\d)${escaped}(?!\\d)` : escaped, 'g');
  };
  return typed.reduce((out, value) => out.replace(pattern(value), '[value]'), text).trim();
}
