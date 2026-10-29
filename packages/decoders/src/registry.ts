import type { Hit, Request } from '@pingwright/core';
import type { Decoder, NewHitId } from './decoder.ts';
import { ga4 } from './ga4.ts';
import { googleAds } from './google-ads.ts';
import { meta } from './meta.ts';

export const decoders: readonly Decoder[] = [ga4, meta, googleAds];

export function decodeRequest(req: Request, newHitId?: NewHitId): Hit[] {
  return decoders.filter((d) => d.match(req)).flatMap((d) => d.decode(req, newHitId));
}

export function isCollectionEndpoint(req: Request): boolean {
  return decoders.some((d) => d.isCollectionEndpoint(req));
}
