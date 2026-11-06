import type { ConsentValue, Hit, HitConsent, Request } from '@tagreeve/core';
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

export const GCD_SIGNALS = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'] as const;
export type GcdSignalName = (typeof GCD_SIGNALS)[number];

/** `notSet` is the letter `l`. Otherwise the default and update values the letter stands for; `unknown` means the letter says nothing about that one. */
export type GcdSignal = { notSet: true } | { notSet: false; default: ConsentValue; update: ConsentValue };

// gcd letters per signal, community-documented only: https://complianz.io/consent-mode-for-7-0
const GCD_LETTERS: Record<string, GcdSignal> = {
  p: { notSet: false, default: 'denied', update: 'unknown' },
  q: { notSet: false, default: 'denied', update: 'denied' },
  r: { notSet: false, default: 'denied', update: 'granted' },
  t: { notSet: false, default: 'granted', update: 'unknown' },
  m: { notSet: false, default: 'unknown', update: 'denied' },
  n: { notSet: false, default: 'unknown', update: 'granted' },
  u: { notSet: false, default: 'granted', update: 'denied' },
  v: { notSet: false, default: 'granted', update: 'granted' },
  l: { notSet: true },
};

/** The single `gcd` letter table. The letters sit at indexes 2, 4, 6 and 8, counting from 0. Undefined when `gcd` is absent or too short. */
export function gcdSignals(gcd: string | undefined): Record<GcdSignalName, GcdSignal> | undefined {
  if (!gcd || gcd.length < 9) return undefined;
  const out = {} as Record<GcdSignalName, GcdSignal>;
  GCD_SIGNALS.forEach((name, i) => {
    out[name] = GCD_LETTERS[gcd[2 + 2 * i]!] ?? { notSet: false, default: 'unknown', update: 'unknown' };
  });
  return out;
}

/** The four signal letters in `GCD_SIGNALS` order, `?` for a letter outside the table. Undefined when `gcdSignals` is. */
export function gcdLetters(gcd: string | undefined): string[] | undefined {
  if (!gcdSignals(gcd)) return undefined;
  return GCD_SIGNALS.map((_, i) => (gcd![2 + 2 * i]! in GCD_LETTERS ? gcd![2 + 2 * i]! : '?'));
}

function gcdValue(signal: GcdSignal): ConsentValue {
  if (signal.notSet) return 'unknown';
  return signal.update !== 'unknown' ? signal.update : signal.default;
}

function parseGcd(gcd: string | undefined): ConsentValue[] | undefined {
  const signals = gcdSignals(gcd);
  return signals && GCD_SIGNALS.map((name) => gcdValue(signals[name]));
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
