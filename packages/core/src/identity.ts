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

// Assigned geographic codes only: N11 service codes and unassigned codes fail phone validation at some checkouts.
const US_AREA_CODES = [201, 202, 206, 212, 213, 214, 305, 312, 404, 415, 512, 602, 617, 702, 718, 808];

/** Only the label `country` follows the option; address, zip and phone stay US-shaped. */
export function createIdentity(seed: number, options: { country?: string } = {}): Identity {
  const faker = new Faker({ locale: [en_US, en, base] });
  faker.seed(seed);
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const tag = faker.string.alphanumeric({ length: 4, casing: 'lower' });
  const area = faker.helpers.arrayElement(US_AREA_CODES);
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
// The lookbehind keeps a long run of local-part characters from being retried at every offset.
const EMAIL = /(?<![a-z0-9._+-])[a-z0-9._+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
// Asset names such as logo@2x.png look like emails.
const FILE_EXTENSION = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|map|woff2?|ttf|otf|eot|wasm|webm)$/i;
const PHONE = /(?<![\w+])\+(?=\d)\d(?:[ .+-]?\d){7,14}(?!\d)|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g;
const HASH = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi;
// Keys whose values are random or hashed client identifiers, not personal data.
const NON_PERSONAL_HASH_KEYS = new Set([
  'uid',
  'user_id',
  'userid',
  'external_id',
  'externalid',
  'client_id',
  'clientid',
  'client_id_hash',
  'clientidhash',
  'cid',
  'controllerid',
  'controller_id',
  'visitor_id',
  'visitorid',
  'device_id',
  'deviceid',
  'session_id',
  'sessionid',
  'anonymous_id',
  'anonymousid',
]);
const KEY_BEFORE_VALUE = /([\w.[\]-]+)["']?\s*[=:]\s*["']?$/;
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

function isNonPersonalKey(text: string, index: number): boolean {
  const key = KEY_BEFORE_VALUE.exec(text.slice(Math.max(0, index - 64), index))?.[1];
  if (!key) return false;
  return NON_PERSONAL_HASH_KEYS.has(key.toLowerCase().replace(/[[\]]/g, '_').replace(/^_+|_+$/g, ''));
}

// A prefix glued to the value shifts the base64 alignment, so each piece is also tried from offsets 1 to 3.
function* base64Candidates(text: string): Generator<string> {
  for (const token of text.match(BASE64_TOKEN) ?? []) {
    const pieces = new Set([token]);
    for (const sep of ['/', '_', '-']) {
      if (token.includes(sep)) for (const piece of token.split(sep)) if (piece.length >= 12) pieces.add(piece);
    }
    for (const piece of pieces) {
      yield piece;
      for (let offset = 1; offset <= 3; offset++) if (piece.length - offset >= 12) yield piece.slice(offset);
    }
  }
}

function isDigestToken(token: string): boolean {
  const bare = token.replace(/=+$/, '');
  if (bare.length !== 43 || !/[a-z]/.test(bare) || !/[A-Z]/.test(bare) || !/\d/.test(bare)) return false;
  return Buffer.from(bare.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 32;
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
  for (const hex of [...hashes]) {
    const bytes = Buffer.from(hex, 'hex');
    hashes.add(bytes.toString('base64').replace(/=+$/, ''));
    hashes.add(bytes.toString('base64url'));
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
      if (!m.includes('@') || FILE_EXTENSION.test(m) || normalizeEmail(m) === own.email) continue;
      add('email', m);
      // One '+' is either a form-encoded space or a plus-address tag, so both readings are reported.
      if (raw !== m && raw.indexOf('+') === raw.lastIndexOf('+') && !raw.startsWith('+')) add('email', raw);
    }
    for (const m of variant.match(PHONE) ?? []) {
      const digits = m.replace(/\D/g, '');
      if (digits !== own.phoneDigits && digits !== own.phoneDigits.slice(1)) add('phone', m);
    }
    for (const m of variant.matchAll(HASH)) {
      if (!own.hashes.has(m[0].toLowerCase()) && !isNonPersonalKey(variant, m.index)) add('hash', m[0].toLowerCase());
    }
    for (const m of variant.matchAll(BASE64_TOKEN)) {
      const bare = m[0].replace(/=+$/, '');
      if (isDigestToken(m[0]) && !own.hashes.has(bare) && !isNonPersonalKey(variant, m.index)) add('hash', m[0]);
    }
  }
  return [...found.values()];
}
