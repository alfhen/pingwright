import { newId, type Flag, type Hit, type Id, type NetworkMode, type Request } from '@pingwright/core';
import { decoders, isCollectionEndpoint, isSandboxPageUrl } from '@pingwright/decoders';
import { hostMatches } from '@pingwright/expect';
import { getDomain } from 'tldts';
import { isKnownVendorCollection } from './stub.ts';

const ALWAYS_DATA = new Set(['fetch', 'xhr', 'ping', 'beacon']);
const DATA_WITH_PAYLOAD = new Set(['image', 'other']);

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export interface FirstPartyScope {
  siteHost: string;
  /** Extra hosts or `*.domain` wildcards treated as first party. */
  firstPartyHosts?: readonly string[];
}

/** First party: the registrable domain of the site, or a listed host. Hosts without one (IPs, localhost) match only exactly. */
function isFirstPartyHost(host: string, { siteHost, firstPartyHosts = [] }: FirstPartyScope): boolean {
  if (host === siteHost || hostMatches(host, firstPartyHosts)) return true;
  const domain = getDomain(siteHost, { allowPrivateDomains: true });
  return domain !== null && getDomain(host, { allowPrivateDomains: true }) === domain;
}

/** A request that no decoder claims and that can carry data. Returns its host, or undefined. */
function undecodedDataHost(req: Request): string | undefined {
  const url = parse(req.url);
  if (!url || !/^https?:$/.test(url.protocol)) return undefined;
  if (decoders.some((d) => d.match(req)) || isCollectionEndpoint(req) || isKnownVendorCollection(req)) return undefined;
  const carriesData =
    ALWAYS_DATA.has(req.resourceType) || (DATA_WITH_PAYLOAD.has(req.resourceType) && (url.search.length > 1 || !!req.postData));
  return carriesData ? url.hostname : undefined;
}

/** True for a request to a non-first-party host that no decoder claims and that can carry data. */
export function isUnknownDestination(req: Request, scope: FirstPartyScope | string): boolean {
  const host = undecodedDataHost(req);
  return host !== undefined && !isFirstPartyHost(host, typeof scope === 'string' ? { siteHost: scope } : scope);
}

/** True for such a request to a first-party host other than the exact site host. */
export function isFirstPartySubdomain(req: Request, scope: FirstPartyScope): boolean {
  const host = undecodedDataHost(req);
  return host !== undefined && host !== scope.siteHost && isFirstPartyHost(host, scope);
}

function flag(runId: Id<'run'>, kind: string, recordIds: string[], detail: string): Flag {
  return { type: 'flag', id: newId('flag'), runId, kind, recordIds, detail };
}

export interface FlagInput {
  runId: Id<'run'>;
  networkMode: NetworkMode;
  siteUrl: string;
  firstPartyHosts?: readonly string[];
  requests: readonly Request[];
  hits: readonly Hit[];
  /** Ids of requests that Playwright routed. A collection request that was seen but not routed escaped stub mode. */
  routedRequestIds: ReadonlySet<string>;
}

export function buildFlags({ runId, networkMode, siteUrl, firstPartyHosts, requests, hits, routedRequestIds }: FlagInput): Flag[] {
  const scope = { siteHost: parse(siteUrl)?.hostname ?? '', firstPartyHosts };
  const flags: Flag[] = [];
  for (const req of requests) {
    if (isUnknownDestination(req, scope)) {
      flags.push(flag(runId, 'unknownDestination', [req.id], `${req.method} ${req.url}`));
    } else if (isFirstPartySubdomain(req, scope)) {
      flags.push(flag(runId, 'firstPartySubdomain', [req.id], `${req.method} ${req.url}`));
    }
    if (networkMode !== 'live' && !routedRequestIds.has(req.id) && (isCollectionEndpoint(req) || isKnownVendorCollection(req))) {
      const why = req.initiator === 'redirect' ? 'It followed a redirect' : 'It was not routed';
      flags.push(flag(runId, 'stubBypass', [req.id], `${why}, so it was not stubbed: ${req.url}`));
    }
  }
  for (const hit of hits) {
    if (isSandboxPageUrl(hit.page)) {
      flags.push(flag(runId, 'sandboxPageUrl', [hit.id, hit.requestId], `${hit.vendor} received ${hit.page} as the page`));
    }
  }
  return flags;
}
