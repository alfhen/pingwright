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

/** Page script that makes card and password fields refuse writes until `window.__pingwrightTrap.release()` runs. */
export const SENSITIVE_WRITE_TRAP = `(() => {
  const name = new RegExp(${JSON.stringify(SENSITIVE_NAME.source)}, 'i');
  const sensitive = (e) => {
    const autocomplete = (e.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/);
    return autocomplete.some((t) => t.startsWith('cc-')) || (e.getAttribute('type') || '').toLowerCase() === 'password' ||
      name.test(e.getAttribute('name') || '') || name.test(e.getAttribute('id') || '');
  };
  const state = { blocked: false };
  const restores = [];
  const refuse = () => { state.blocked = true; throw new Error('card and password fields cannot be set by a script'); };
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    for (const prop of ['value', 'defaultValue']) {
      const original = Object.getOwnPropertyDescriptor(proto, prop);
      if (!original || !original.set) continue;
      Object.defineProperty(proto, prop, { ...original, set(v) { if (sensitive(this)) refuse(); original.set.call(this, v); } });
      restores.push(() => Object.defineProperty(proto, prop, original));
    }
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (attr, v) {
    const isField = this instanceof HTMLInputElement || this instanceof HTMLTextAreaElement;
    if (isField && /^value$/i.test(String(attr)) && sensitive(this)) refuse();
    if (isField && /^type$/i.test(String(attr)) && /^password$/i.test(String(v))) refuse();
    return setAttribute.call(this, attr, v);
  };
  restores.push(() => { Element.prototype.setAttribute = setAttribute; });
  window.__pingwrightTrap = { state, release: () => restores.forEach((r) => r()) };
})()`;
