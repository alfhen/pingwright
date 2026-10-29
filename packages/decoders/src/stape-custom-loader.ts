import type { Hit, Request } from '@pingwright/core';
import { decodeBase64Text } from './base64.ts';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';

export const STAPE_LOADER_TRANSPORT = 'stape-loader';

/** Rewrites `/<id>?<key>=<base64 path>` to the decoded path and query on the same host. */
export function unwrapStapeLoader(req: Request): Request | undefined {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  if (!/^\/[^/]+$/.test(url.pathname)) return undefined;
  const real: string[] = [];
  for (const [, value] of url.searchParams) {
    const decoded = decodeBase64Text(value);
    if (decoded && /^\/[^/\s\\][\x21-\x7e]*$/.test(decoded)) real.push(decoded);
  }
  if (real.length !== 1) return undefined;
  try {
    return { ...req, url: new URL(real[0]!, url.origin).href };
  } catch {
    return undefined;
  }
}

/** `inner` must not contain the loader itself. */
export function createStapeCustomLoader(inner: readonly Decoder[]): Decoder {
  return {
    name: 'stape-custom-loader',
    match(req) {
      const real = unwrapStapeLoader(req);
      return real !== undefined && inner.some((d) => d.match(real, true));
    },
    isCollectionEndpoint(req) {
      const real = unwrapStapeLoader(req);
      return real !== undefined && inner.some((d) => d.isCollectionEndpoint(real, true));
    },
    decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
      const real = unwrapStapeLoader(req);
      if (!real) return [];
      return inner
        .filter((d) => d.match(real, true))
        .flatMap((d) => d.decode(real, newHitId, true))
        .map((hit) => ({ ...hit, transport: `${hit.transport} via ${STAPE_LOADER_TRANSPORT}` }));
    },
  };
}
