import { newId, type DataLayerEvent, type Flag, type Hit, type Id, type Identity, type NetworkMode, type Request } from '@pingwright/core';
import { decoders, isCollectionEndpoint, isSandboxPageUrl, trackerList, type TrackerEntry } from '@pingwright/decoders';
import { findForeignData, hostMatches } from '@pingwright/expect';
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
function undecodedDataHost(req: Request, trackers: readonly TrackerEntry[]): string | undefined {
  const url = parse(req.url);
  if (!url || !/^https?:$/.test(url.protocol)) return undefined;
  if (decoders.some((d) => d.match(req)) || isCollectionEndpoint(req, trackers) || isKnownVendorCollection(req)) return undefined;
  const carriesData =
    ALWAYS_DATA.has(req.resourceType) || (DATA_WITH_PAYLOAD.has(req.resourceType) && (url.search.length > 1 || !!req.postData));
  return carriesData ? url.hostname : undefined;
}

/** True for a request to a non-first-party host that no decoder claims and that can carry data. */
export function isUnknownDestination(req: Request, scope: FirstPartyScope | string, trackers: readonly TrackerEntry[] = trackerList): boolean {
  const host = undecodedDataHost(req, trackers);
  return host !== undefined && !isFirstPartyHost(host, typeof scope === 'string' ? { siteHost: scope } : scope);
}

/** True for such a request to a first-party host other than the exact site host. */
export function isFirstPartySubdomain(req: Request, scope: FirstPartyScope, trackers: readonly TrackerEntry[] = trackerList): boolean {
  const host = undecodedDataHost(req, trackers);
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
  /** The tracker list in force. Default: the built-in list. */
  trackers?: readonly TrackerEntry[];
  requests: readonly Request[];
  hits: readonly Hit[];
  /** When given, requests and hits are scanned for data that is not the identity's. */
  identity?: Identity | null;
  /** Ids of requests that Playwright routed. A collection request that was seen but not routed escaped stub mode. */
  routedRequestIds: ReadonlySet<string>;
}

export function buildFlags({ runId, networkMode, siteUrl, firstPartyHosts, trackers = trackerList, requests, hits, identity, routedRequestIds }: FlagInput): Flag[] {
  const scope = { siteHost: parse(siteUrl)?.hostname ?? '', firstPartyHosts };
  const flags: Flag[] = [];
  for (const req of requests) {
    if (isUnknownDestination(req, scope, trackers)) {
      flags.push(flag(runId, 'unknownDestination', [req.id], `${req.method} ${req.url}`));
    } else if (isFirstPartySubdomain(req, scope, trackers)) {
      flags.push(flag(runId, 'firstPartySubdomain', [req.id], `${req.method} ${req.url}`));
    }
    if (networkMode !== 'live' && !routedRequestIds.has(req.id) && (isCollectionEndpoint(req, trackers) || isKnownVendorCollection(req))) {
      const why = req.initiator === 'redirect' ? 'It followed a redirect' : 'It was not routed';
      flags.push(flag(runId, 'stubBypass', [req.id], `${why}, so it was not stubbed: ${req.url}`));
    }
  }
  for (const hit of hits) {
    if (isSandboxPageUrl(hit.page)) {
      flags.push(flag(runId, 'sandboxPageUrl', [hit.id, hit.requestId], `${hit.vendor} received ${hit.page} as the page`));
    }
  }
  if (identity) {
    for (const leak of findForeignData(requests, hits, identity)) flags.push(flag(runId, 'possibleRealData', leak.evidence, leak.detail));
  }
  return flags;
}

/** GA4 holds hits for a visitor who has not consented for about 5 s, then flushes them as the page unloads. */
const UNLOAD_GAP_WINDOW_MS = 10_000;
const UNLOAD_GAP_SLACK_MS = 1_000;

const GA4_EVENTS = new Set([
  'add_payment_info', 'add_shipping_info', 'add_to_cart', 'add_to_wishlist', 'begin_checkout', 'generate_lead', 'login', 'purchase', 'refund',
  'remove_from_cart', 'search', 'select_content', 'select_item', 'select_promotion', 'share', 'sign_up', 'view_cart', 'view_item', 'view_item_list', 'view_promotion',
]);

/** Shopify standard event names and a few common aliases, mapped to the GA4 name a pixel normally sends. Not exhaustive. */
const GA4_ALIASES: Readonly<Record<string, string>> = {
  product_added_to_cart: 'add_to_cart',
  product_removed_from_cart: 'remove_from_cart',
  product_viewed: 'view_item',
  collection_viewed: 'view_item_list',
  cart_viewed: 'view_cart',
  checkout_started: 'begin_checkout',
  payment_info_submitted: 'add_payment_info',
  checkout_shipping_info_submitted: 'add_shipping_info',
  checkout_completed: 'purchase',
  search_submitted: 'search',
};

function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${glob.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

export interface UnloadGapInput {
  runId: Id<'run'>;
  networkMode?: NetworkMode;
  /** dataLayer events pushed from frames other than the main frame. */
  events: readonly DataLayerEvent[];
  hits: readonly Hit[];
  /** Times at which the main frame started a navigation. */
  navigations: readonly number[];
  /** Event names or `*` globs that are never reported. */
  ignore?: readonly string[];
}

function unloadGapAdvice(networkMode: NetworkMode | undefined): string {
  return networkMode === 'live'
    ? 'which is not captured without --net-log'
    : 'which stub mode cannot capture. Add the name to options.unloadGapIgnore if the hit is not needed, or check it in a live run with --network live --net-log';
}

/**
 * An event pushed in an embedded frame shortly before the page navigated may have a GA4 hit that the frame flushed
 * while unloading. Chromium does not report those requests to the browser context.
 * Only events that look like tracking events are checked: some vendor sent a hit of that name, or the name is a GA4
 * recommended event. GA4 is expected when the run has any GA4 hit or the name is a GA4 event. An alias in `GA4_ALIASES` (`product_added_to_cart` for `add_to_cart`) only lets a GA4 hit of the mapped name cover the event: the gates use the literal name. Another vendor's hit
 * does not cover it, except when the run has no GA4 hit at all: then a hit of any vendor with the same name covers it. For a name that is not a GA4 event, any later GA4 hit with a GA4 event name covers it.
 */
export function buildUnloadGapFlags({ runId, networkMode, events, hits, navigations, ignore = [] }: UnloadGapInput): Flag[] {
  const ignored = ignore.map(globToRegExp);
  const ga4Hits = hits.filter((h) => h.vendor === 'ga4');
  const flags: Flag[] = [];
  for (const event of events) {
    const name = event.event;
    if (name === null || event.isConsentCommand || name.startsWith('gtm.') || ignored.some((re) => re.test(name))) continue;
    const navigation = navigations.find((n) => n >= event.t);
    if (navigation === undefined || navigation - event.t > UNLOAD_GAP_WINDOW_MS) continue;
    const expected = GA4_ALIASES[name] ?? name;
    const ga4Name = GA4_EVENTS.has(expected);
    const literalGa4Name = GA4_EVENTS.has(name);
    if (!literalGa4Name && !hits.some((h) => h.event === name)) continue;
    if (!literalGa4Name && ga4Hits.length === 0) continue;
    const covered = (h: Hit) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && h.event === name;
    if (ga4Hits.length === 0 && hits.some(covered)) continue;
    if (ga4Hits.some((h) => h.t >= event.t && h.t <= navigation + UNLOAD_GAP_SLACK_MS && h.event !== null && (h.event === name || h.event === expected || (!ga4Name && GA4_EVENTS.has(h.event))))) continue;
    const seconds = ((navigation - event.t) / 1000).toFixed(1);
    flags.push(
      flag(
        runId,
        'unloadGap',
        [event.id],
        `A frame pushed "${name}" ${seconds} s before the page navigated and no ga4 hit for it was recorded after it. The frame may have sent the hit while unloading, ${unloadGapAdvice(networkMode)} (design §5.3).`,
      ),
    );
  }
  return flags;
}
