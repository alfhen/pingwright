import type { Identity, Step as StepRecord } from '@pingwright/core';
import { canonicalCard, findPaymentProvider, type PaymentProvider } from '@pingwright/expect';
import type { Page } from 'playwright';
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
      { kind: 'number', frame: '#card-frame', input: '#cc-number' },
      { kind: 'expiry', frame: '#card-frame', input: '#cc-exp' },
      { kind: 'cvc', frame: '#card-frame', input: '#cc-csc' },
    ],
  },
};

const MARKER_TIMEOUT_MS = 5000;

/** What the CLI hands to the run once gates 1 and 2 have passed. */
export interface TestPayment {
  /** The `--allow-test-payment` host. */
  host: string;
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

/** The frame element exists and its document is served from the provider's card host. */
async function cardFrameServed(page: Page, field: CardField, cardHost: string, deadline: number): Promise<boolean> {
  for (;;) {
    try {
      const element = await page.locator(field.frame).first().elementHandle({ timeout: Math.max(1, deadline - Date.now()) });
      const frame = await element?.contentFrame();
      if (frame && hostOf(frame.url()) === cardHost) return true;
    } catch {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  const wait = Math.min(timeout, MARKER_TIMEOUT_MS);
  try {
    await page.locator(runtime.marker).first().waitFor({ state: 'visible', timeout: wait });
  } catch {
    throw new Error('test mode not detected');
  }
  const deadline = Date.now() + wait;
  for (const field of runtime.fields) {
    if (!(await cardFrameServed(page, field, runtime.cardHost, deadline))) throw new Error(`card frame not found (${field.kind})`);
  }
  record.payment = { provider: provider.id, mode: 'test' };
  recorder.holdRedaction();
  for (const field of runtime.fields) {
    try {
      await page.frameLocator(field.frame).locator(field.input).fill(valueOf(field.kind, provider, card, identity), { timeout });
    } catch {
      throw new Error(`card field ${field.kind} could not be filled`);
    }
  }
}
