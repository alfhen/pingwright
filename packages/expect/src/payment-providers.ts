export interface PaymentProvider {
  id: string;
  /** The provider's own page that lists these test values. */
  docs: string;
  /** Card values a `payment` step may type, as the docs write them without spaces. */
  cards: readonly string[];
  expiry: string;
  cvc: string;
  /** Only allowed when the real `--site` host is a loopback host. */
  loopbackOnly?: boolean;
}

export const PAYMENT_PROVIDERS: readonly PaymentProvider[] = [
  {
    id: 'shopify-bogus',
    docs: 'https://help.shopify.com/en/manual/checkout-settings/test-orders',
    cards: ['1', '2', '3'],
    expiry: '12/40',
    cvc: '123',
  },
  {
    id: 'shopify-test',
    docs: 'https://help.shopify.com/en/manual/payments/shopify-payments/testing-shopify-payments',
    cards: ['4242424242424242', '5555555555554444'],
    expiry: '12/40',
    cvc: '123',
  },
  {
    id: 'fixture',
    docs: 'https://github.com/alfhen/tagreeve/blob/main/fixtures/site/README.md',
    cards: ['4242424242424242'],
    expiry: '12/40',
    cvc: '123',
    loopbackOnly: true,
  },
];

export function findPaymentProvider(id: string): PaymentProvider | undefined {
  return PAYMENT_PROVIDERS.find((p) => p.id === id);
}

/** The documented form of a card value, or undefined when it is not one of the provider's. Spaces and dashes are ignored. */
export function canonicalCard(provider: PaymentProvider, card: string): string | undefined {
  const compact = card.replace(/[\s-]/g, '');
  return provider.cards.includes(compact) ? compact : undefined;
}
