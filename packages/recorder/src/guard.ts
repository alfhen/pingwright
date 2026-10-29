const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SENSITIVE_NAME = /card|cvc|cvv|iban|password/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export interface FieldAttributes {
  autocomplete: string | null;
  name: string | null;
  id: string | null;
  type: string | null;
}

/** A card or password field: autocomplete cc-*, type=password, or a name or id that looks like a card or password. */
export function isSensitiveField(field: FieldAttributes): boolean {
  const autocomplete = (field.autocomplete ?? '').toLowerCase().split(/\s+/);
  return (
    autocomplete.some((token) => token.startsWith('cc-')) ||
    (field.type ?? '').toLowerCase() === 'password' ||
    SENSITIVE_NAME.test(field.name ?? '') ||
    SENSITIVE_NAME.test(field.id ?? '')
  );
}

export const HANDOFF_REQUIRED = 'Payments and log-ins must be handoff steps on any site that is not on this machine.';
