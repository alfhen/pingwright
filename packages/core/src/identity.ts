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
const EMAIL = /[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const PHONE = /(?<![A-Za-z0-9+])\+\d{8,15}(?!\d)|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
const HASH = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
const BASE64_TOKEN = /[A-Za-z0-9+/_-]{12,}={0,2}/g;

function tryUrlDecode(text: string): string | undefined {
  if (!/%[0-9a-f]{2}/i.test(text)) return undefined;
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

// Random bytes seldom decode to valid UTF-8 with few control characters, so this keeps ULIDs and hashes out.
function tryBase64Decode(token: string): string | undefined {
  const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length < 8) return undefined;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  let control = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || c === 0xfffd) control++;
  }
  return control / text.length <= 0.05 ? text : undefined;
}

function hasUrlEscapes(text: string): boolean {
  const decoded = tryUrlDecode(text);
  return decoded !== undefined && decoded !== text;
}

function* base64Candidates(text: string): Generator<string> {
  for (const token of text.match(BASE64_TOKEN) ?? []) {
    yield token;
    if (token.includes('/')) {
      for (const piece of token.split('/')) if (piece.length >= 12) yield piece;
    }
  }
}

// Only base64 decoding spends depth; URL decoding is cheap and a disguised Stape URL layers it between base64 steps.
function* variants(text: string, depth = 0, seen = new Set<string>()): Generator<string> {
  if (seen.has(text)) return;
  seen.add(text);
  yield text;
  const url = tryUrlDecode(text);
  if (url !== undefined && url !== text) yield* variants(url, depth, seen);
  if (depth >= MAX_DEPTH) return;
  for (const token of base64Candidates(text)) {
    const decoded = tryBase64Decode(token);
    if (decoded !== undefined) yield* variants(decoded, depth + 1, seen);
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
  // Vendors such as Meta strip spaces and punctuation before hashing names and cities.
  for (const field of fields) {
    const lower = field.trim().toLowerCase();
    hashes.add(sha256(lower).hex);
    hashes.add(sha256(lower.replace(/[^\p{L}\p{N}]/gu, '')).hex);
  }
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
    // Escaped text is matched through its decoded variant, so adjacent escapes never join a local part.
    for (const raw of hasUrlEscapes(variant) ? [] : (variant.match(EMAIL) ?? [])) {
      // A '+' may be a form-encoded space ("Order+for+a@b.com"), so only the part after the last one counts.
      const m = raw.slice(raw.lastIndexOf('+') + 1);
      if (m.includes('@') && normalizeEmail(m) !== own.email) add('email', m);
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
