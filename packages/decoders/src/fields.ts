import { MAX_POST_DATA, type Hit, type Request } from '@pingwright/core';
import { isIdentifierField } from './identifiers.ts';

/** A field name and its value. The value is read to classify the field and is never stored. */
export interface FieldEntry {
  name: string;
  value: string;
}

export const OTHER_NAME = '(other)';

const NAME_CHARS = /^[A-Za-z0-9_[\]-]*$/;
const HEX_TOKEN = /^[0-9a-fA-F]{32,}$/;
const DIGEST_TOKEN = /^[A-Za-z0-9_-]{22,}$/;
const LONG_DIGITS = /\d{6,}/;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function looksLikeValue(segment: string): boolean {
  if (segment.length > 64 || !NAME_CHARS.test(segment)) return true;
  if (HEX_TOKEN.test(segment) || LONG_DIGITS.test(segment)) return true;
  return DIGEST_TOKEN.test(segment) && /[A-Z]/.test(segment) && /[a-z]/.test(segment) && /\d/.test(segment);
}

/**
 * A data tag can use a value as a key. A dotted segment that looks like a value is stored as `(other)`.
 * A name with an `@` is one email split on its dots, so the whole name is stored as `(other)`.
 */
export function guardFieldName(name: string): string {
  if (name.includes('@')) return OTHER_NAME;
  return name
    .split('.')
    .map((segment) => (looksLikeValue(segment) ? OTHER_NAME : segment))
    .join('.');
}

export function queryEntries(params: Iterable<[string, string]>): FieldEntry[] {
  const out: FieldEntry[] = [];
  for (const [name, value] of params) if (value !== '') out.push({ name, value });
  return out;
}

/** Nested names use dots, array items collapse to `[]`, and empty values are skipped. */
export function jsonEntries(value: unknown, prefix = ''): FieldEntry[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => jsonEntries(item, `${prefix}[]`));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => jsonEntries(child, prefix ? `${prefix}.${key}` : key));
  }
  const text = String(value);
  return text === '' || prefix === '' ? [] : [{ name: prefix, value: text }];
}

export interface BodyEntries {
  entries: FieldEntry[];
  /** False when the body is JSON that does not parse. */
  parsed: boolean;
}

/** The JSON or form-encoded body of a request. */
export function bodyEntries(req: Pick<Request, 'postData'>): BodyEntries {
  const text = req.postData;
  if (!text || text.trim() === '') return { entries: [], parsed: true };
  if (/^\s*[{[]/.test(text)) {
    try {
      return { entries: jsonEntries(JSON.parse(text) as unknown), parsed: true };
    } catch {
      return { entries: [], parsed: false };
    }
  }
  return { entries: queryEntries(new URLSearchParams(text)), parsed: true };
}

/** False when the recorder holds only part of the body, or none of a body the request must have had. */
export function bodyComplete(req: Pick<Request, 'method' | 'postData' | 'captured'>): boolean {
  if (req.postData === null) return !(req.captured === 'netlog' && BODY_METHODS.has(req.method.toUpperCase()));
  return req.postData.length < MAX_POST_DATA;
}

/** Sets `fields`, `fieldsComplete` and `idFields` on a hit from the entries of its payload. Only names are kept. */
export function withFields(hit: Hit, entries: readonly FieldEntry[], complete: boolean): Hit {
  const fields = new Set<string>();
  const idFields = new Set<string>();
  for (const { name, value } of entries) {
    const guarded = guardFieldName(name);
    fields.add(guarded);
    if (isIdentifierField(name, value)) idFields.add(guarded);
  }
  return { ...hit, fields: [...fields].sort(), fieldsComplete: complete, idFields: [...idFields].sort() };
}
