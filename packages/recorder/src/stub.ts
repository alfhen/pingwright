import { isLibraryLoadPath, type Request } from '@pingwright/core';
import { isCollectionEndpoint, type TrackerEntry } from '@pingwright/decoders';
import { hostMatches } from '@pingwright/expect';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

export interface StubResponse {
  status: number;
  headers: Record<string, string>;
  body?: Buffer;
}

/** CORS headers that let a credentialed cross-origin request, also from an opaque origin, read the stub. */
export function corsHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {
    'access-control-allow-origin': headers.origin ?? '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin',
  };
  const requested = headers['access-control-request-headers'];
  if (requested) out['access-control-allow-headers'] = requested;
  return out;
}

/** A 1x1 GIF for images, an empty script or page for those loads, 204 for everything else. */
export function stubResponse(req: Pick<Request, 'resourceType' | 'headers'>): StubResponse {
  const cors = corsHeaders(req.headers);
  switch (req.resourceType) {
    case 'image':
      return { status: 200, headers: { ...cors, 'content-type': 'image/gif', 'cache-control': 'no-store' }, body: GIF };
    case 'script':
      return { status: 200, headers: { ...cors, 'content-type': 'application/javascript', 'cache-control': 'no-store' }, body: Buffer.alloc(0) };
    case 'document':
      return { status: 200, headers: { ...cors, 'content-type': 'text/html', 'cache-control': 'no-store' }, body: Buffer.alloc(0) };
    default:
      return { status: 204, headers: cors };
  }
}

const LOADS = new Set(['script', 'stylesheet', 'font', 'document']);
const VENDOR_HOST =
  /(^|\.)(facebook\.com|facebook\.net|doubleclick\.net|googleadservices\.com|googlesyndication\.com|googletagmanager\.com)$|^(www\.)?google\.com$/;
const COLLECTION_PATH = /^\/(?:tr|pagead\/(?:viewthroughconversion|conversion|1p-[\w-]+)|rmkt|ccm|td)(?:\/|$)/;
const SITE_FUNCTION_PATH = /^\/(?:recaptcha|maps|plugins|dialog|login)(?:\/|$)/;

/**
 * Requests to Google ad hosts or Meta that must be stubbed whatever the decoder registry holds. Collection paths
 * count for every resource type, because gtag.js sends Ads hits as script requests. Only library loads and other
 * non-collection loads continue.
 */
export function isKnownVendorCollection(req: Pick<Request, 'url' | 'resourceType'>): boolean {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  if (!VENDOR_HOST.test(url.hostname)) return false;
  if (isLibraryLoadPath(url.pathname)) return false;
  if (COLLECTION_PATH.test(url.pathname)) return true;
  if (SITE_FUNCTION_PATH.test(url.pathname)) return false;
  return !LOADS.has(req.resourceType);
}

export interface StubDecisionOptions {
  networkMode: 'stub' | 'server' | 'live';
  serverHosts?: readonly string[];
  trackers: readonly TrackerEntry[];
}

/** A collection request that stub and `server` mode answer locally. `server` mode lets the hosts in `serverHosts` through. */
export function isStubbedCollection(req: Request, options: StubDecisionOptions): boolean {
  if (!isCollectionEndpoint(req, options.trackers) && !isKnownVendorCollection(req)) return false;
  if (options.networkMode !== 'server') return true;
  let host: string;
  try {
    host = new URL(req.url).hostname;
  } catch {
    return true;
  }
  const bare = (h: string) => h.replace(/^\[|\]$/g, '');
  return !hostMatches(bare(host), (options.serverHosts ?? []).map(bare));
}

/** The names, never the values, of the cookies a header set carries. */
export function setCookieNamesOf(headers: Record<string, string>): string[] {
  return Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === 'set-cookie')
    .flatMap(([, value]) => value.split('\n'))
    .map((c) => c.split('=')[0]!.trim());
}
