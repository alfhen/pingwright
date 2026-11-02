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
}

interface ProviderRuntime {
  /** Visible on the top page only when the provider is in test mode. */
  marker: string;
  /** The exact host every card frame must be served from. */
  cardHost: string;
  fields: CardField[];
}

const SHOPIFY_CARD_HOST = 'checkout.pci.shopifyinc.com';

const shopifyFields: CardField[] = [
  { kind: 'number', frame: 'iframe[title*="Card number" i]', input: 'input' },
  { kind: 'expiry', frame: 'iframe[title*="Expiration" i]', input: 'input' },
  { kind: 'cvc', frame: 'iframe[title*="Security code" i]', input: 'input' },
  { kind: 'name', frame: 'iframe[title*="Name on card" i]', input: 'input' },
];

const RUNTIME: Record<string, ProviderRuntime> = {
  'shopify-bogus': { marker: 'text=Bogus Gateway', cardHost: SHOPIFY_CARD_HOST, fields: shopifyFields },
  'shopify-test': { marker: 'text=/test mode/i', cardHost: SHOPIFY_CARD_HOST, fields: shopifyFields },
  fixture: {
    marker: '#pw-test-mode',
    cardHost: '127.0.0.1',
    fields: [
      { kind: 'number', frame: '#card-frame, #card-frame-number', input: '#cc-number' },
      { kind: 'expiry', frame: '#card-frame, #card-frame-exp', input: '#cc-exp' },
      { kind: 'cvc', frame: '#card-frame, #card-frame-csc', input: '#cc-csc' },
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

interface CardFrame {
  element: ElementHandle;
  frame: Frame;
}

/** The first matching iframe that is visible and whose document is served from the card host, or the reason there is none. */
async function cardFrameServed(page: Page, field: CardField, cardHost: string, deadline: number): Promise<CardFrame | string> {
  let reason = 'not found';
  for (;;) {
    try {
      let hidden = false;
      let elsewhere = false;
      for (const element of await page.locator(field.frame).elementHandles()) {
        const frame = await element.contentFrame();
        if (!frame) continue;
        const served = hostOf(frame.url()) === cardHost;
        if (served && (await element.isVisible())) return { element, frame };
        if (served) hidden = true;
        else elsewhere = true;
      }
      reason = hidden ? 'not visible' : elsewhere ? 'served from another host' : 'not found';
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
      await fillVerified(found[index]!.element, field, runtime.cardHost, valueOf(field.kind, provider, card, identity), timeout);
    } catch (error) {
      throw new Error(`card field ${field.kind} could not be filled: ${reasonOf(error, typed)}`);
    }
    if (index === 0) record.payment = { provider: provider.id, mode: 'test', testMode: declared ? 'declared' : 'marker' };
  }
}

async function frameStillServed(element: ElementHandle, cardHost: string): Promise<Frame> {
  const frame = await element.contentFrame();
  if (!frame || hostOf(frame.url()) !== cardHost) throw new Error('the card frame is gone or not served from the card host');
  return frame;
}

/** Types into the one visible input of the frame that the frame check verified, and checks that frame's host again right before the fill. */
async function fillVerified(element: ElementHandle, field: CardField, cardHost: string, value: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const frame = await frameStillServed(element, cardHost);
    const inputs = frame.locator(field.input).filter({ visible: true });
    const count = await inputs.count();
    if (count === 1) {
      await frameStillServed(element, cardHost);
      await inputs.fill(value, { timeout: Math.max(1, deadline - Date.now()) });
      return;
    }
    if (Date.now() >= deadline) throw new Error(`${count} visible inputs match`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function typedValues(provider: PaymentProvider, card: string, identity: Identity): string[] {
  const values = [card, provider.expiry, provider.cvc, identity.firstName, identity.lastName, `${identity.firstName} ${identity.lastName}`];
  return values.filter((v) => v.length > 0).sort((a, b) => b.length - a.length);
}

/** The first line of the error, with every typed value removed. */
function reasonOf(error: unknown, typed: string[]): string {
  const first = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
  return typed.reduce((text, value) => text.split(value).join('[value]'), first).trim() || 'unknown error';
}
