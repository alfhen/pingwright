import { hashEmail, type Hit, type Identity, type Request } from '@tagreeve/core';
import { hostMatches } from '@tagreeve/expect';

/** A shared value shorter than this proves nothing. */
const MIN_VALUE_LENGTH = 8;
const CLIENT_ID_NAMES = new Set(['cid', 'client_id', 'clientid', 'fbp']);

function bare(host: string): string {
  return host.replace(/^\[|\]$/g, '');
}

function eventIdOf(hit: Hit): string | undefined {
  return hit.params.eventId ?? hit.params.eid ?? hit.params.event_id;
}

function collectNamed(value: unknown, names: ReadonlySet<string>, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNamed(item, names, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (names.has(key.toLowerCase()) && (typeof item === 'string' || typeof item === 'number')) out.add(String(item));
      else collectNamed(item, names, out);
    }
  }
}

function clientIdsOf(request: Request): Set<string> {
  const found = new Set<string>();
  const addQuery = (query: URLSearchParams) => {
    for (const [key, value] of query) if (CLIENT_ID_NAMES.has(key.toLowerCase().replace(/^ud\[(.*)\]$/, '$1'))) found.add(value);
  };
  try {
    addQuery(new URL(request.url).searchParams);
  } catch {
    // An unparsable URL holds no client ID.
  }
  const body = request.postData;
  if (body) {
    try {
      collectNamed(JSON.parse(body) as unknown, CLIENT_ID_NAMES, found);
    } catch {
      for (const line of body.split(/\r?\n/)) addQuery(new URLSearchParams(line));
    }
  }
  return new Set([...found].filter((v) => v.length >= MIN_VALUE_LENGTH));
}

function holdsIdentity(request: Request, identity: Identity | null): boolean {
  if (!identity?.email) return false;
  const email = identity.email.trim().toLowerCase();
  const values = [email, hashEmail(identity.email).hex].filter((v) => v.length >= MIN_VALUE_LENGTH);
  const raw = `${request.url}\n${request.postData ?? ''}`;
  let decoded = '';
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the raw text only.
  }
  const text = `${raw}\n${decoded}`.toLowerCase();
  return values.some((v) => text.includes(v));
}

interface Facts {
  hit: Hit;
  request: Request | undefined;
  eventId: string | undefined;
  clientIds: Set<string>;
  identity: boolean;
  onServerHost: boolean;
}

export interface LinkInput {
  hits: readonly Hit[];
  requests: readonly Request[];
  serverHosts: readonly string[];
  identity: Identity | null;
}

function sharedKind(server: Facts, browser: Facts): 'eventId' | 'clientId' | 'identity' | undefined {
  if (server.eventId && server.eventId.length >= MIN_VALUE_LENGTH && server.eventId === browser.eventId) return 'eventId';
  for (const id of server.clientIds) if (browser.clientIds.has(id)) return 'clientId';
  if (server.identity && browser.identity) return 'identity';
  return undefined;
}

/**
 * Adds `via` to each hit decoded from a server container call. The proxy cannot see which browser hit led to a call,
 * so the first rule that fits decides: (1) the event ID and event name match exactly one browser hit, `exact`;
 * (2) a shared value, `probable`: the latest earlier hit to a `serverHosts` host, else the latest earlier browser hit.
 * No match leaves the hit unlinked. Browser hits are returned as they are.
 */
export function linkServerHits({ hits, requests, serverHosts, identity }: LinkInput): Hit[] {
  const byId = new Map(requests.map((r) => [r.id, r]));
  const patterns = serverHosts.map(bare);
  const facts: Facts[] = hits.map((hit) => {
    const request = byId.get(hit.requestId);
    let onServerHost = false;
    if (request) {
      try {
        onServerHost = hostMatches(bare(new URL(request.url).hostname), patterns);
      } catch {
        onServerHost = false;
      }
    }
    return {
      hit,
      request,
      eventId: eventIdOf(hit),
      clientIds: request ? clientIdsOf(request) : new Set(),
      identity: request ? holdsIdentity(request, identity) : false,
      onServerHost,
    };
  });
  const isServer = (f: Facts) => f.request?.captured === 'serverContainer';
  const browser = facts.filter((f) => !isServer(f));
  return facts.map((f): Hit => {
    if (!isServer(f)) return f.hit;
    const exact = f.eventId === undefined ? [] : browser.filter((b) => b.eventId === f.eventId && b.hit.event === f.hit.event);
    if (exact.length === 1) return { ...f.hit, via: { hitId: exact[0]!.hit.id, by: 'eventId', confidence: 'exact' } };
    const earlier = browser.flatMap((b) => {
      const by = b.hit.t <= f.hit.t ? sharedKind(f, b) : undefined;
      return by ? [{ b, by }] : [];
    });
    const pool = earlier.some((c) => c.b.onServerHost) ? earlier.filter((c) => c.b.onServerHost) : earlier;
    const latest = pool.reduce<(typeof pool)[number] | undefined>((best, c) => (best === undefined || c.b.hit.t >= best.b.hit.t ? c : best), undefined);
    return latest ? { ...f.hit, via: { hitId: latest.b.hit.id, by: latest.by, confidence: 'probable' } } : f.hit;
  });
}
