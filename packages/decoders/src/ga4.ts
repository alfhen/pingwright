import type { ConsentValue, Hit, HitConsent, Request } from '@pingwright/core';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';
import { bodyComplete, queryEntries, withFields } from './fields.ts';

function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function isGa4Collect(req: Request): boolean {
  const url = parseUrl(req.url);
  return url?.pathname.endsWith('/g/collect') === true && url.searchParams.get('v') === '2';
}

function gcsValue(flag: string | undefined): ConsentValue {
  if (flag === '1') return 'granted';
  if (flag === '0') return 'denied';
  return 'unknown';
}

// gcd letters per signal: https://complianz.io/consent-mode-for-7-0
const GCD_LETTERS: Record<string, ConsentValue> = {
  p: 'denied',
  q: 'denied',
  r: 'granted',
  t: 'granted',
  m: 'denied',
  n: 'granted',
  u: 'denied',
  v: 'granted',
  l: 'unknown',
};

/** Order in the string: ad_storage, analytics_storage, ad_user_data, ad_personalization. */
function parseGcd(gcd: string | undefined): ConsentValue[] | undefined {
  if (!gcd || gcd.length < 9) return undefined;
  return [2, 4, 6, 8].map((i) => GCD_LETTERS[gcd[i]!] ?? 'unknown');
}

function pick(...values: (ConsentValue | undefined)[]): ConsentValue {
  return values.find((v) => v === 'granted' || v === 'denied') ?? 'unknown';
}

export function decodeGa4Consent(params: URLSearchParams): HitConsent {
  const raw: Record<string, string> = {};
  const gcs = params.get('gcs') ?? undefined;
  const gcd = params.get('gcd') ?? undefined;
  if (gcs) raw.gcs = gcs;
  if (gcd) raw.gcd = gcd;
  const g = /^G1([01])([01])/.exec(gcs ?? '');
  const d = parseGcd(gcd);
  return {
    ads: pick(gcsValue(g?.[1]), d?.[0]),
    analytics: pick(gcsValue(g?.[2]), d?.[1]),
    adUserData: pick(d?.[2]),
    adPersonalization: pick(d?.[3]),
    raw,
  };
}

function transport(resourceType: string): string {
  return resourceType === 'ping' ? 'beacon' : resourceType;
}

function eventLines(req: Request): URLSearchParams[] {
  const base = new URL(req.url).searchParams;
  const lines = (req.postData ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [base];
  return lines.map((line) => {
    const own = new URLSearchParams(line);
    const merged = new URLSearchParams(base);
    for (const key of new Set(own.keys())) merged.delete(key);
    for (const [k, v] of own) merged.append(k, v);
    return merged;
  });
}

function eventParams(p: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of p) {
    if (k.startsWith('ep.')) out[k.slice(3)] = v;
    else if (k.startsWith('epn.')) out[k.slice(4)] = v;
  }
  return out;
}

export const ga4: Decoder = {
  name: 'ga4',
  match: isGa4Collect,
  isCollectionEndpoint: isGa4Collect,
  decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
    if (!isGa4Collect(req)) return [];
    const complete = bodyComplete(req);
    return eventLines(req).map((p) => {
      const ids: Hit['ids'] = {};
      if (p.get('cid')) ids.client_id = true;
      if (p.get('uid')) ids.user_id = true;
      const tid = p.get('tid');
      return withFields({
        type: 'hit',
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: 'ga4',
        event: p.get('en'),
        consent: decodeGa4Consent(p),
        ids,
        page: p.get('dl'),
        transport: transport(req.resourceType),
        params: { ...eventParams(p), ...(tid ? { tid } : {}) },
      }, queryEntries(p), complete);
    });
  },
};
