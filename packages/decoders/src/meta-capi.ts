import type { HashedId, Hit, Request } from '@tagreeve/core';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';
import { bodyComplete, jsonEntries, withFields } from './fields.ts';

type Json = Record<string, unknown>;

const HASH_FIELDS = ['em', 'ph', 'fn', 'ln', 'ct', 'zp', 'country', 'external_id'];
// The names the hashesMatch rule reads from `params`.
export const META_CAPI_PARAM_NAMES: Record<string, string> = {
  em: 'hashedEmail',
  ph: 'hashedPhone',
  fn: 'user_data.first_name',
  ln: 'user_data.last_name',
  ct: 'user_data.city',
  zp: 'user_data.postal_code',
  country: 'user_data.country',
};
/** Strips the index of a further value (`user_data.city.1` is `user_data.city`). */
export function metaCapiBaseParam(name: string): string {
  return name.replace(/\.\d+$/, '');
}

const PRESENCE_FIELDS = ['fbp', 'fbc'];
const EVENTS_PATH = /^\/v\d+(?:\.\d+)?\/(\d+)\/events\/?$/;

function eventsPixel(req: Pick<Request, 'url'>): string | undefined {
  try {
    const url = new URL(req.url);
    return url.hostname === 'graph.facebook.com' ? EVENTS_PATH.exec(url.pathname)?.[1] : undefined;
  } catch {
    return undefined;
  }
}

/** True for any method, so the CORS preflight of a browser call is stubbed too. */
export function isMetaCapiEndpoint(req: Pick<Request, 'url'>): boolean {
  return eventsPixel(req) !== undefined;
}

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  const first: unknown = Array.isArray(v) ? v[0] : v;
  if (typeof first === 'string') return first === '' ? undefined : first;
  return typeof first === 'number' ? String(first) : undefined;
}

function strs(v: unknown): string[] {
  return (Array.isArray(v) ? v : [v]).flatMap((item: unknown) => {
    if (typeof item === 'string') return item === '' ? [] : [item];
    return typeof item === 'number' ? [String(item)] : [];
  });
}

/** The `data` array of a JSON body, or of a form body whose `data` field is JSON. Undefined when there is none. */
function eventItems(body: string | null): Json[] | undefined {
  if (!body) return undefined;
  try {
    const json: unknown = /^\s*[{[]/.test(body) ? JSON.parse(body) : JSON.parse(new URLSearchParams(body).get('data') ?? '');
    const data: unknown = isObject(json) ? json.data : json;
    return Array.isArray(data) && data.every(isObject) ? (data as Json[]) : undefined;
  } catch {
    return undefined;
  }
}

function decodeItem(item: Json, req: Request, pixel: string, newHitId: NewHitId, complete: boolean): Hit {
  const userData = isObject(item.user_data) ? item.user_data : {};
  const ids: Hit['ids'] = {};
  const hashes: Record<string, HashedId> = {};
  const params: Record<string, string> = { pixelId: pixel };
  for (const field of HASH_FIELDS) {
    const values = strs(userData[field]);
    if (values.length === 0) continue;
    hashes[field] = { present: true, matchesIdentity: null };
    const param = META_CAPI_PARAM_NAMES[field];
    // The first value keeps the plain name; the others are indexed (`hashedEmail.1`), so hashesMatch checks each.
    if (param) values.forEach((value, i) => (params[i === 0 ? param : `${param}.${i}`] = value));
  }
  if (Object.keys(hashes).length > 0) ids.hashes = hashes;
  for (const field of PRESENCE_FIELDS) if (str(userData[field])) ids[field] = true;
  const eventId = str(item.event_id);
  if (eventId) {
    ids.event_id = true;
    params.eventId = eventId;
  }
  return withFields({
    type: 'hit',
    id: newHitId(),
    runId: req.runId,
    stepId: req.stepId,
    requestId: req.id,
    t: req.t,
    vendor: 'meta-capi',
    event: str(item.event_name) ?? null,
    consent: { ads: 'unknown', analytics: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} },
    ids,
    page: str(item.event_source_url) ?? null,
    transport: req.resourceType === 'ping' ? 'beacon' : req.resourceType,
    params,
  }, jsonEntries(item), complete);
}

export const metaCapi: Decoder = {
  name: 'meta-capi',
  match: (req) => req.method.toUpperCase() === 'POST' && eventsPixel(req) !== undefined,
  isCollectionEndpoint: isMetaCapiEndpoint,
  decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
    const pixel = eventsPixel(req);
    if (req.method.toUpperCase() !== 'POST' || pixel === undefined) return [];
    const items = eventItems(req.postData);
    if (!items) return [decodeItem({}, req, pixel, newHitId, false)];
    const complete = bodyComplete(req);
    return items.map((item) => decodeItem(item, req, pixel, newHitId, complete));
  },
};
