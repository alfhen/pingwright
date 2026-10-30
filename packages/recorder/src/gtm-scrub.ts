import type { RunRecords } from '@pingwright/core';

export const REDACTED = '[redacted]';

const MAX_DEPTH = 8;
const BASE64_TOKEN = /[A-Za-z0-9+/_-]{8,}={0,2}/g;
const QUERY_LIKE = /^[\w.[\]-]+=[^&\s]*(?:&[\w.[\]-]+=[^&\s]*)*$/;

/** Lenient on purpose: bytes that are not UTF-8 around the secret must not hide it, so the text is read as latin1. */
function decodeBase64Text(value: string): string | undefined {
  const v = value.replace(/ /g, '+');
  if (v.length < 4 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return undefined;
  const bare = v.replace(/=+$/, '');
  if (bare.length % 4 === 1) return undefined;
  return Buffer.from(bare.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
}

function urlDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function queryValues(text: string): string[] {
  const query = text.includes('?') ? text.slice(text.indexOf('?') + 1) : text;
  return query.split('&').flatMap((pair) => (pair.includes('=') ? [pair.slice(pair.indexOf('=') + 1)] : []));
}

/** True when the secret is in the text or in any URL-decoded or base64-decoded layer of it, including query values found inside decoded text. */
export function containsSecret(text: string, secret: string, depth = 0): boolean {
  // Decoding only shortens text, and the encoded secret is never shorter than the secret.
  if (text.length < secret.length) return false;
  if (text.includes(secret)) return true;
  if (depth >= MAX_DEPTH) return false;
  const next = depth + 1;
  const decoded = urlDecode(text);
  if (decoded !== text && containsSecret(decoded, secret, next)) return true;
  const whole = decodeBase64Text(text);
  if (whole !== undefined && containsSecret(whole, secret, next)) return true;
  if (/[?&=]/.test(text)) {
    for (const value of queryValues(text)) {
      if (value !== text && containsSecret(value, secret, next)) return true;
    }
  }
  for (const token of text.match(BASE64_TOKEN) ?? []) {
    if (token === text) continue;
    const inner = decodeBase64Text(token);
    if (inner !== undefined && containsSecret(inner, secret, next)) return true;
  }
  return false;
}

export class Scrubber {
  constructor(private readonly secret: string) {}

  /** The whole string becomes `[redacted]` if any decoded layer holds the secret. */
  value(text: string): string {
    return containsSecret(text, this.secret) ? REDACTED : text;
  }

  private pairs(query: string): string {
    return query
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq < 0) return this.value(pair);
        return containsSecret(pair.slice(eq + 1), this.secret) ? `${pair.slice(0, eq + 1)}${REDACTED}` : pair;
      })
      .join('&');
  }

  /** Each query value that holds the secret is redacted. A secret anywhere else in the URL redacts the whole URL. */
  url(url: string): string {
    const hash = url.indexOf('#');
    const base = hash < 0 ? url : url.slice(0, hash);
    const q = base.indexOf('?');
    const out = q < 0 ? url : `${base.slice(0, q)}?${this.pairs(base.slice(q + 1))}${hash < 0 ? '' : url.slice(hash)}`;
    return this.value(out);
  }

  /** A form-encoded body (one or more lines) loses only the values that hold the secret. Any other body is redacted whole. */
  body(body: string): string {
    const lines = body.split('\n');
    if (lines.every((line) => line === '' || QUERY_LIKE.test(line))) {
      return lines.map((line) => (line === '' ? line : this.pairs(line))).join('\n');
    }
    return this.value(body);
  }

  /** Free text such as CLI output: occurrences are replaced, and a line that still holds the secret in a decoded layer is redacted. */
  text(text: string): string {
    return text
      .split('\n')
      .map((line) => this.value(line.split(this.secret).join(REDACTED)))
      .join('\n');
  }

  deep<T>(input: T): T {
    if (typeof input === 'string') return this.value(input) as T;
    if (Array.isArray(input)) return input.map((item) => this.deep(item)) as T;
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(Object.entries(input).map(([k, v]) => [this.value(k), this.deep(v)])) as T;
    }
    return input;
  }

  records(records: RunRecords): RunRecords {
    const { requests, ...rest } = records;
    return {
      ...this.deep(rest),
      requests: requests.map((r) => ({
        ...this.deep({ ...r, url: '', postData: null }),
        url: this.url(r.url),
        postData: r.postData === null ? null : this.body(r.postData),
      })),
    };
  }
}
