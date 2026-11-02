import type { Hit, Request } from '@tagreeve/core';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';
import { bodyComplete, multipartPartName, multipartParts, queryEntries, withFields } from './fields.ts';

const META_HOSTS = new Set(['facebook.com', 'www.facebook.com']);

function isMetaTr(req: Request): boolean {
  try {
    const url = new URL(req.url);
    return META_HOSTS.has(url.hostname) && /^\/tr\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function bodyFields(req: Request): Iterable<[string, string]> {
  const body = req.postData ?? '';
  const parts = multipartParts(body, req.headers);
  if (!parts) return new URLSearchParams(body);
  const fields: [string, string][] = [];
  for (const part of parts) {
    const name = multipartPartName(part);
    if (name !== undefined) fields.push([name, part.body]);
  }
  return fields;
}

function allParams(req: Request): URLSearchParams {
  const merged = new URLSearchParams(new URL(req.url).search);
  if (req.method === 'POST' && req.postData) {
    for (const [k, v] of bodyFields(req)) merged.set(k, v);
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
    const udNames: Record<string, string> = { em: 'hashedEmail', ph: 'hashedPhone' };
    for (const [k, v] of p) {
      const ud = /^ud\[(.+)\]$/.exec(k);
      if (!ud?.[1] || v === '') continue;
      const name = udNames[ud[1]] ?? ud[1];
      ids[name] = true;
      params[name] = v;
    }
    return [
      withFields({
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
      }, queryEntries(p), bodyComplete(req)),
    ];
  },
};
