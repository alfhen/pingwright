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
// '+' separates digit groups only in a whole value (ph=+45+12+34+56+78); inside text it is a form-encoded space.
// A "+" starts a phone only at the start of a value: after punctuation in form-encoded text it is a space.
const PHONE = /(?<=^|[=\s"']|tel:)\+(?=\d)\d(?:[ .-]?\d){7,14}(?!\d|\+\d)|(?<=^|[=\s"'])\+\d+(?:\+\d+)+(?=$|[&\s"'])|\(\d{3}\)\s?\d{3}[-.\s]\d{4}|(?<![\w-])(?:1[-.\s])?\d{3}[-.\s]\d{3}[-.\s]\d{4}(?![\w-])/g;
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
  'state',
  'nonce',
  'csrf',
  'csrf_token',
  'csrftoken',
]);
// GA4 sends event parameters as ep.<name> and epn.<name>; other vendors nest the name in cd[...].
const KEY_PREFIX = /^(?:epn?|up|upn|cd|ud)[._]/;
const KEY_BEFORE_VALUE = /([\w.[\]-]+)["']?\s*[=:]\s*["']?$/;
const MULTIPART_KEY = /\bname=["']([\w.[\]-]+)["'][^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n$/;
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

const utf8Lenient = new TextDecoder('utf-8');
const EDGE = 4;
const MIN_BYTES_FOR_EDGES = 12;

// Random bytes seldom decode to mostly valid text, so this keeps ULIDs and hashes out. Junk glued to either
// end of a payload decodes to a few stray bytes there, so the first and last few characters are not counted.
function tryBase64Decode(token: string): string | undefined {
  const bytes = Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (bytes.length < 8) return undefined;
  const text = utf8Lenient.decode(bytes);
  const inner = bytes.length >= MIN_BYTES_FOR_EDGES ? [...text].slice(EDGE, -EDGE) : [...text];
  if (inner.length < 4) return undefined;
  let control = 0;
  for (const ch of inner) {
    const c = ch.codePointAt(0)!;
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || c === 0xfffd) control++;
  }
  return control / inner.length <= 0.05 ? text : undefined;
}

function hasUrlEscapes(text: string): boolean {
  const decoded = tryUrlDecode(text);
  return decoded !== undefined && decoded !== text;
}

function isNonPersonalKey(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 128), index);
  const key = KEY_BEFORE_VALUE.exec(before.slice(-64))?.[1] ?? MULTIPART_KEY.exec(before)?.[1];
  if (!key) return false;
  const name = key.toLowerCase().replace(/[[\]]/g, '_').replace(/^_+|_+$/g, '').replace(KEY_PREFIX, '');
  return NON_PERSONAL_HASH_KEYS.has(name);
}

const MAX_BOUNDARIES = 8;
const GLUE = new Set(['_', '-', '+']);

// Junk glued to a value shifts the base64 alignment and adds stray bytes, so pieces cut at '_', '-' and '+' are tried
// as well, each from offsets 0 to 3. Only the outermost boundaries are used to keep long separator runs linear.
function* glueCuts(piece: string): Generator<string> {
  yield piece;
  const bounds: number[] = [];
  for (let i = 0; i < piece.length && bounds.length < MAX_BOUNDARIES; i++) if (GLUE.has(piece[i]!)) bounds.push(i);
  const tail: number[] = [];
  for (let i = piece.length - 1; i >= 0 && tail.length < MAX_BOUNDARIES; i--) if (GLUE.has(piece[i]!)) tail.push(i);
  const all = [...new Set([...bounds, ...tail])];
  if (all.length === 0) return;
  const first = Math.min(...all);
  const last = Math.max(...all);
  for (const i of all) {
    yield piece.slice(i + 1);
    yield piece.slice(0, i);
  }
  if (last > first) yield piece.slice(first + 1, last);
}

function* base64Decodes(text: string): Generator<string> {
  for (const token of text.match(BASE64_TOKEN) ?? []) {
    const pieces = new Set([token]);
    if (token.includes('/')) for (const piece of token.split('/')) if (piece.length >= 12) pieces.add(piece);
    const seen = new Set<string>();
    const attempt = (candidate: string): string | undefined => {
      if (candidate.length < 12 || seen.has(candidate)) return undefined;
      seen.add(candidate);
      return tryBase64Decode(candidate);
    };
    for (const piece of pieces) {
      for (const cut of glueCuts(piece)) {
        for (let offset = 0; offset <= 3; offset++) {
          const decoded = attempt(cut.slice(offset));
          if (decoded !== undefined) {
            yield decoded;
          }
        }
      }
    }
  }
}

const DIGEST_VALUE = '([A-Za-z0-9+/_-]{43}={0,2})(?![A-Za-z0-9+/_=-])';
// Base64 digests are only recognised under these keys; by shape alone they cannot be told from readable text.
const IDENTITY_DIGEST_KEY = new RegExp(
  `(?<![\\w.\\[\\]-])(?:em|ph|fn|ln|ud\\[[^\\]&=]+\\]|sha256_(?:email_address|phone_number|first_name|last_name)|user_data\\.[\\w.]+)["']?\\s*[=:]\\s*["']?${DIGEST_VALUE}`,
  'gi',
);
const ADS_USER_DATA = /tv\.1~([^&\s"']*)/gi;
const ADS_FIELD = /^(?:em|ph|fn|ln)\.(.+)$/i;

function isDigest(token: string): boolean {
  const bare = token.replace(/=+$/, '');
  return bare.length === 43 && Buffer.from(bare.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === 32;
}

function* keyedDigests(text: string): Generator<string> {
  for (const m of text.matchAll(IDENTITY_DIGEST_KEY)) if (isDigest(m[1]!)) yield m[1]!;
  for (const m of text.matchAll(ADS_USER_DATA)) {
    for (const field of m[1]!.split('~')) {
      const value = ADS_FIELD.exec(field)?.[1];
      if (value !== undefined && /^[A-Za-z0-9+/_-]{43}={0,2}$/.test(value) && isDigest(value)) yield value;
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
  for (const decoded of base64Decodes(text)) yield* variants(decoded, depth + 1, seen);
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
      if (!m.includes('@') || FILE_EXTENSION.test(m) || normalizeEmail(m).includes(own.email)) continue;
      add('email', m);
      // One '+' is either a form-encoded space or a plus-address tag, so both readings are reported.
      if (raw !== m && raw.indexOf('+') === raw.lastIndexOf('+') && !raw.startsWith('+')) add('email', raw);
    }
    for (const m of variant.match(PHONE) ?? []) {
      const digits = m.replace(/\D/g, '');
      if (digits.length < 8 || digits.length > 15) continue;
      // In the form-encoded "+cc+nn+nn" shape the first group is a country code, which has 1 to 3 digits.
      if (/^\+\d+\+/.test(m) && !/^\+\d{1,3}\+/.test(m)) continue;
      if (!digits.includes(own.phoneDigits) && !digits.includes(own.phoneDigits.slice(1))) add('phone', m);
    }
    // The decoded variant carries the same hex, with its key readable.
    for (const m of hasUrlEscapes(variant) ? [] : variant.matchAll(HASH)) {
      if (!own.hashes.has(m[0].toLowerCase()) && !isNonPersonalKey(variant, m.index)) add('hash', m[0].toLowerCase());
    }
    // Escaped text is matched through its decoded variant, so a percent-encoded '=' never splits a digest.
    for (const token of hasUrlEscapes(variant) ? [] : keyedDigests(variant)) {
      if (!own.hashes.has(token.replace(/=+$/, ''))) add('hash', token);
    }
  }
  return [...found.values()];
}
