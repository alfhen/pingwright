import type { Hit, Request } from '@pingwright/core';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';

function onCollectionHost(req: Request): URL | undefined {
  try {
    const url = new URL(req.url);
    return url.hostname === 'ct.pinterest.com' ? url : undefined;
  } catch {
    return undefined;
  }
}

function isPinterestCollect(req: Request): boolean {
  const url = onCollectionHost(req);
  return url !== undefined && /^\/(?:v3|user)\/?$/.test(url.pathname);
}

// The whole host is stubbed: the tag also posts telemetry to /stats/ there.
function isPinterestHost(req: Request): boolean {
  return onCollectionHost(req) !== undefined;
}

function jsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

function flatten(prefix: string, value: unknown, out: Record<string, string>): void {
  const s = text(value);
  if (s !== undefined) {
    if (prefix) out[prefix === 'event_id' ? 'eventId' : prefix] = s;
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, child] of Object.entries(value)) flatten(prefix ? `${prefix}.${k}` : k, child, out);
  }
}

function bracketKeys(name: string): { group: string; path: string } | undefined {
  const m = /^(ed|pd)((?:\[[^\]]+\])+)$/.exec(name);
  if (!m?.[1] || !m[2]) return undefined;
  return { group: m[1], path: m[2].slice(1, -1).split('][').join('.') };
}

export const pinterest: Decoder = {
  name: 'pinterest',
  match: isPinterestCollect,
  isCollectionEndpoint: isPinterestHost,
  decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
    if (!isPinterestCollect(req)) return [];
    const p = new URL(req.url).searchParams;
    const ed = jsonObject(p.get('ed'));
    const pd = jsonObject(p.get('pd'));
    const ad = jsonObject(p.get('ad'));
    const params: Record<string, string> = {};
    const tid = p.get('tid');
    if (tid) params.tagId = tid;
    flatten('', ed, params);
    let em = text(pd.em);
    for (const [name, value] of p) {
      const key = bracketKeys(name);
      if (!key || !value) continue;
      if (key.group === 'pd') {
        if (key.path === 'em') em = value;
      } else {
        params[key.path === 'event_id' ? 'eventId' : key.path] = value;
      }
    }
    const ids: Hit['ids'] = {};
    if (em) {
      ids.hashedEmail = true;
      params.hashedEmail = em;
    }
    return [
      {
        type: 'hit',
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: 'pinterest',
        event: p.get('event'),
        consent: {
          ads: 'unknown',
          analytics: 'unknown',
          adUserData: 'unknown',
          adPersonalization: 'unknown',
          raw: {},
        },
        ids,
        page: text(ad.loc) ?? null,
        transport: req.resourceType === 'ping' ? 'beacon' : req.resourceType,
        params,
      },
    ];
  },
};
