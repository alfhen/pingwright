import type { Hit, Request } from '@pingwright/core';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';

const META_HOSTS = new Set(['facebook.com', 'www.facebook.com']);

function isMetaTr(req: Request): boolean {
  try {
    const url = new URL(req.url);
    return META_HOSTS.has(url.hostname) && /^\/tr\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function allParams(req: Request): URLSearchParams {
  const merged = new URLSearchParams(new URL(req.url).search);
  if (req.method === 'POST' && req.postData) {
    for (const [k, v] of new URLSearchParams(req.postData)) merged.set(k, v);
  }
  return merged;
}

export const meta: Decoder = {
  name: 'meta',
  match: isMetaTr,
  isCollectionEndpoint: isMetaTr,
  decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
    if (!isMetaTr(req)) return [];
    const p = allParams(req);
    const ids: Hit['ids'] = {};
    const params: Record<string, string> = {};
    const pixel = p.get('id');
    if (pixel) params.pixelId = pixel;
    const eid = p.get('eid');
    if (eid) params.eid = eid;
    for (const [k, v] of p) {
      const cd = /^cd\[(.+)\]$/.exec(k);
      if (cd?.[1]) params[cd[1]] = v;
    }
    const em = p.get('ud[em]');
    if (em) {
      ids.hashedEmail = true;
      params.hashedEmail = em;
    }
    const ph = p.get('ud[ph]');
    if (ph) {
      ids.hashedPhone = true;
      params.hashedPhone = ph;
    }
    return [
      {
        type: 'hit',
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: 'meta',
        event: p.get('ev'),
        consent: {
          ads: 'unknown',
          analytics: 'unknown',
          adUserData: 'unknown',
          adPersonalization: 'unknown',
          raw: {},
        },
        ids,
        page: p.get('dl'),
        transport: req.resourceType === 'ping' ? 'beacon' : req.resourceType,
        params,
      },
    ];
  },
};
