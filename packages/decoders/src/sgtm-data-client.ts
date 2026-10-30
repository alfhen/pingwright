import type { Hit, Request } from '@pingwright/core';
import { decodeBase64Text } from './base64.ts';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';
import { decodeGa4Consent } from './ga4.ts';

type Json = Record<string, unknown>;

function parseObject(text: string | undefined | null): Json {
  if (!text) return {};
  try {
    const json: unknown = JSON.parse(text);
    return json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Json) : {};
  } catch {
    return {};
  }
}

const parseDtdc = (value: string | null): Json => parseObject(value ? decodeBase64Text(value) : undefined);

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const hasId = (v: unknown): boolean => str(v) !== undefined || (typeof v === 'number' && Number.isFinite(v));

const USER_DATA_FIELDS = ['email_address', 'phone_number', 'first_name', 'last_name', 'street', 'city', 'postal_code', 'country'];

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const firstOf = (v: unknown): unknown => (Array.isArray(v) ? v.find((x) => str(x) !== undefined || isObject(x)) : v);

/**
 * Reads `user_data` as `user_data.<field>`. Address fields sit at its top level or under `address`
 * (an object, or a list whose first object is used). The Stape Data Tag sends the same names as
 * top-level body fields, read only when there is no `user_data` object. A list value uses its first string.
 */
function userData(...sources: Json[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    const hasUserData = isObject(source.user_data);
    const fields: Json = hasUserData ? (source.user_data as Json) : source;
    const addressValue = firstOf(fields.address);
    const address = isObject(addressValue) ? addressValue : {};
    for (const field of USER_DATA_FIELDS) {
      const value = str(firstOf(fields[field])) ?? str(firstOf(address[field]));
      if (value && out[`user_data.${field}`] === undefined) out[`user_data.${field}`] = value;
    }
  }
  return out;
}

/** Outside the Stape loader the path alone is too common, so a request needs a Data Tag signature. */
function dataRequest(req: Request, viaLoader: boolean): URL | undefined {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  if (url.pathname !== '/data') return undefined;
  if (viaLoader) return url;
  const p = url.searchParams;
  if (Object.keys(parseDtdc(p.get('dtdc'))).length > 0) return url;
  if (p.has('v') && (p.has('event') || p.has('en'))) return url;
  const body = req.method === 'POST' ? parseObject(req.postData) : {};
  return str(body.event_name) && str(body.page_location) ? url : undefined;
}

export const sgtmDataClient: Decoder = {
  name: 'sgtm-data-client',
  match: (req, viaLoader = false) => dataRequest(req, viaLoader) !== undefined,
  isCollectionEndpoint: (req, viaLoader = false) => dataRequest(req, viaLoader) !== undefined,
  decode(req: Request, newHitId: NewHitId = defaultHitId, viaLoader = false): Hit[] {
    const url = dataRequest(req, viaLoader);
    if (!url) return [];
    const p = url.searchParams;
    const dtdc = parseDtdc(p.get('dtdc'));
    const body = req.method === 'POST' ? parseObject(req.postData) : {};
    const ids: Hit['ids'] = {};
    if (p.get('cid') || hasId(body.client_id)) ids.client_id = true;
    if (p.get('uid') || hasId(body.user_id)) ids.user_id = true;
    const params: Record<string, string> = {};
    const tid = p.get('tid');
    if (tid) params.tid = tid;
    const hostname = str(dtdc.page_hostname) ?? str(body.page_hostname);
    if (hostname) params.page_hostname = hostname;
    Object.assign(params, userData(dtdc, body));
    return [
      {
        type: 'hit',
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: 'sgtm',
        event: p.get('event') ?? p.get('en') ?? str(dtdc.event_name) ?? str(body.event_name) ?? null,
        consent: decodeGa4Consent(p),
        ids,
        page: str(dtdc.page_location) ?? str(body.page_location) ?? null,
        transport: req.resourceType === 'ping' ? 'beacon' : req.resourceType,
        params,
      },
    ];
  },
};
