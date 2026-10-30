import { isLibraryLoadPath, type Hit, type Request } from '@pingwright/core';
import { isSandboxPageUrl } from './sandbox.ts';
import { defaultHitId, type NewHitId } from './decoder.ts';
import { trackerFor, trackerList, type TrackerEntry } from './tracker-list.ts';

const LOADS = new Set(['script', 'stylesheet', 'font', 'document']);
const EVENT_PARAMS = ['event', 'ev', 'event_name', 'en', 'evt', 'ea'];
const PAGE_PARAMS = ['dl', 'page_location', 'page_url', 'url', 'u', 'loc', 'href'];

/**
 * The listed entry for a request that stub mode answers locally and that decodes to a tracker hit. An entry with
 * paths counts for every resource type, because collection also arrives as JSONP scripts and iframe pixels. An
 * entry for a whole host leaves library loads and other script, stylesheet, font and document loads alone.
 */
export function trackerCollection(
  req: Pick<Request, 'url' | 'resourceType'>,
  list: readonly TrackerEntry[] = trackerList,
): TrackerEntry | undefined {
  const entry = trackerFor(req, list);
  if (!entry) return undefined;
  if (entry.paths) return entry;
  if (isLibraryLoadPath(new URL(req.url).pathname)) return undefined;
  return LOADS.has(req.resourceType) ? undefined : entry;
}

function firstParam(params: URLSearchParams, names: readonly string[]): string | null {
  for (const name of names) {
    const value = params.get(name);
    if (value) return value;
  }
  return null;
}

export function decodeTracker(req: Request, list: readonly TrackerEntry[] = trackerList, newHitId: NewHitId = defaultHitId): Hit[] {
  const entry = trackerCollection(req, list);
  if (!entry) return [];
  const params = new URL(req.url).searchParams;
  return [
    {
      type: 'hit',
      id: newHitId(),
      runId: req.runId,
      stepId: req.stepId,
      requestId: req.id,
      t: req.t,
      vendor: entry.vendor,
      event: firstParam(params, EVENT_PARAMS),
      consent: { ads: 'unknown', analytics: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} },
      ids: {},
      page: firstParam(params, PAGE_PARAMS) ?? (isSandboxPageUrl(req.frameUrl) ? null : req.frameUrl),
      transport: 'tracker-list',
      params: {},
    },
  ];
}
