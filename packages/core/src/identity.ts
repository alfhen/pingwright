import { createHash } from 'node:crypto';
import { Faker, base, en, en_US } from '@faker-js/faker';

export interface Identity {
  seed: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  city: string;
  zip: string;
  country: string;
}

export interface HashForms {
  hex: string;
  base64: string;
  base64url: string;
}

export function createIdentity(seed: number, options: { country?: string } = {}): Identity {
  const faker = new Faker({ locale: [en_US, en, base] });
  faker.seed(seed);
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const tag = faker.string.alphanumeric({ length: 4, casing: 'lower' });
  const area = faker.number.int({ min: 201, max: 989 });
  // 555-0100 to 555-0199 is reserved for fictional use.
  const line = faker.number.int({ min: 100, max: 199 });
  return {
    seed,
    firstName,
    lastName,
    email: `${firstName}.${lastName}.${tag}@example.com`.toLowerCase().replace(/[^a-z0-9.@]/g, ''),
    phone: `+1${area}5550${line}`,
    address1: faker.location.streetAddress(),
    city: faker.location.city(),
    zip: faker.location.zipCode('#####'),
    country: options.country ?? 'US',
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** E.164 form: a plus sign followed by digits only. */
export function normalizePhone(phone: string): string {
  return '+' + phone.replace(/\D/g, '');
}

export function sha256(value: string): HashForms {
  const digest = createHash('sha256').update(value, 'utf8').digest();
  return {
    hex: digest.toString('hex'),
    base64: digest.toString('base64'),
    base64url: digest.toString('base64url'),
  };
}

export function hashEmail(email: string): HashForms {
  return sha256(normalizeEmail(email));
}

export function hashPhone(phone: string): HashForms {
  return sha256(normalizePhone(phone));
}

export type LeakKind = 'email' | 'phone' | 'hash';

export interface LeakMatch {
  kind: LeakKind;
  /** The value as found after decoding. */
  value: string;
}

const MAX_DEPTH = 3;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const PHONE = /\+\d{8,15}(?!\d)|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
const HASH = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
const BASE64_TOKEN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;

function tryUrlDecode(text: string): string | undefined {
  if (!/%[0-9a-f]{2}/i.test(text)) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

// Random bytes seldom decode to mostly printable text, so this keeps ULIDs and hashes out.
function tryBase64Decode(token: string): string | undefined {
  const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length < 8) return undefined;
  let printable = 0;
  for (const b of bytes) {
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  return printable / bytes.length >= 0.95 ? bytes.toString('latin1') : undefined;
}

function* variants(text: string, depth = 0): Generator<string> {
  yield text;
  if (depth >= MAX_DEPTH) return;
  const url = tryUrlDecode(text);
  if (url !== undefined && url !== text) yield* variants(url, depth + 1);
  for (const token of text.match(BASE64_TOKEN) ?? []) {
    const decoded = tryBase64Decode(token);
    if (decoded !== undefined) yield* variants(decoded, depth + 1);
  }
}

function ownValues(identity: Identity) {
  const email = normalizeEmail(identity.email);
  const phone = normalizePhone(identity.phone);
  const hashes = new Set<string>();
  const fields = [
    email,
    phone,
    phone.slice(1),
    identity.firstName,
    identity.lastName,
    identity.address1,
    identity.city,
    identity.zip,
    identity.country,
  ];
  for (const field of fields) hashes.add(sha256(field.trim().toLowerCase()).hex);
  return { email, phoneDigits: phone.slice(1), hashes };
}

/** Finds emails, phone numbers and SHA-256 hex strings in text that do not belong to the identity. */
export function scan(text: string, identity: Identity): LeakMatch[] {
  const own = ownValues(identity);
  const found = new Map<string, LeakMatch>();
  const add = (kind: LeakKind, value: string) => {
    const key = `${kind}:${value}`;
    if (!found.has(key)) found.set(key, { kind, value });
  };
  for (const variant of variants(text)) {
    for (const m of variant.match(EMAIL) ?? []) {
      if (normalizeEmail(m) !== own.email) add('email', m);
    }
    for (const m of variant.match(PHONE) ?? []) {
      const digits = m.replace(/\D/g, '');
      if (digits !== own.phoneDigits && digits !== own.phoneDigits.slice(1)) add('phone', m);
    }
    for (const m of variant.match(HASH) ?? []) {
      if (!own.hashes.has(m.toLowerCase())) add('hash', m.toLowerCase());
    }
  }
  return [...found.values()];
}
