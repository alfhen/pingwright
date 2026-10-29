import type { Hit, Request } from '@pingwright/core';
import type { Decoder, NewHitId } from './decoder.ts';
import { ga4 } from './ga4.ts';
import { googleAds } from './google-ads.ts';
import { meta } from './meta.ts';
import { sgtmDataClient } from './sgtm-data-client.ts';
import { createStapeCustomLoader } from './stape-custom-loader.ts';

const direct: readonly Decoder[] = [ga4, meta, googleAds, sgtmDataClient];

export const decoders: readonly Decoder[] = [...direct, createStapeCustomLoader(direct)];

export function decodeRequest(req: Request, newHitId?: NewHitId): Hit[] {
  return decoders.filter((d) => d.match(req)).flatMap((d) => d.decode(req, newHitId));
}

export function isCollectionEndpoint(req: Request): boolean {
  return decoders.some((d) => d.isCollectionEndpoint(req));
}

export const vendorKeys: readonly string[] = ['ga4', 'google-ads', 'meta', 'sgtm'];
