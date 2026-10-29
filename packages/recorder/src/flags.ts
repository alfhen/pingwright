import { newId, type Flag, type Hit, type Id, type Request } from '@pingwright/core';
import { decoders, isCollectionEndpoint, isSandboxPageUrl } from '@pingwright/decoders';

const ALWAYS_DATA = new Set(['fetch', 'xhr', 'ping', 'beacon']);
const DATA_WITH_PAYLOAD = new Set(['image', 'other']);

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** True for a request to a third-party host that no decoder claims and that can carry data. */
export function isUnknownDestination(req: Request, siteHost: string): boolean {
  const url = parse(req.url);
  if (!url || !/^https?:$/.test(url.protocol) || url.hostname === siteHost) return false;
  if (decoders.some((d) => d.match(req)) || isCollectionEndpoint(req)) return false;
  if (ALWAYS_DATA.has(req.resourceType)) return true;
  return DATA_WITH_PAYLOAD.has(req.resourceType) && (url.search.length > 1 || !!req.postData);
}

function flag(runId: Id<'run'>, kind: string, recordIds: string[], detail: string): Flag {
  return { type: 'flag', id: newId('flag'), runId, kind, recordIds, detail };
}

export interface FlagInput {
  runId: Id<'run'>;
  siteUrl: string;
  requests: readonly Request[];
  hits: readonly Hit[];
  /** Ids of requests that Playwright routed. A collection request that was seen but not routed escaped stub mode. */
  routedRequestIds: ReadonlySet<string>;
}

export function buildFlags({ runId, siteUrl, requests, hits, routedRequestIds }: FlagInput): Flag[] {
  const siteHost = parse(siteUrl)?.hostname ?? '';
  const flags: Flag[] = [];
  for (const req of requests) {
    if (isUnknownDestination(req, siteHost)) {
      flags.push(flag(runId, 'unknownDestination', [req.id], `${req.method} ${req.url}`));
    }
    if (!routedRequestIds.has(req.id) && isCollectionEndpoint(req)) {
      flags.push(
        flag(runId, 'stubBypass', [req.id], `Collection request was not routed, so it was not stubbed: ${req.url}`),
      );
    }
  }
  for (const hit of hits) {
    if (isSandboxPageUrl(hit.page)) {
      flags.push(flag(runId, 'sandboxPageUrl', [hit.id, hit.requestId], `${hit.vendor} received ${hit.page} as the page`));
    }
  }
  return flags;
}
