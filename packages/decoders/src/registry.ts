import type { Hit, Request } from '@pingwright/core';
import type { Decoder, NewHitId } from './decoder.ts';
import { ga4 } from './ga4.ts';
import { googleAds } from './google-ads.ts';
import { meta } from './meta.ts';
import { pinterest } from './pinterest.ts';
import { sgtmDataClient } from './sgtm-data-client.ts';
import { createStapeCustomLoader } from './stape-custom-loader.ts';
import { decodeTracker, trackerCollection } from './tracker.ts';
import { trackerList, type TrackerEntry } from './tracker-list.ts';

const direct: readonly Decoder[] = [ga4, meta, pinterest, googleAds, sgtmDataClient];

export const decoders: readonly Decoder[] = [...direct, createStapeCustomLoader(direct)];

/** `trackers` is the tracker list to apply. A request that a real decoder matches never also gives a tracker hit. */
export function decodeRequest(req: Request, newHitId?: NewHitId, trackers: readonly TrackerEntry[] = trackerList): Hit[] {
  const matched = decoders.filter((d) => d.match(req));
  if (matched.length > 0) return matched.flatMap((d) => d.decode(req, newHitId));
  return decodeTracker(req, trackers, newHitId);
}

export function isCollectionEndpoint(req: Request, trackers: readonly TrackerEntry[] = trackerList): boolean {
  return decoders.some((d) => d.isCollectionEndpoint(req)) || trackerCollection(req, trackers) !== undefined;
}

