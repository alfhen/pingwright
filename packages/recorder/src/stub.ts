import type { Request } from '@pingwright/core';

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
  /(^|\.)(facebook\.com|facebook\.net|doubleclick\.net|googleadservices\.com|googlesyndication\.com)$|^(www\.)?google\.com$/;
const COLLECTION_PATH = /^\/(?:tr|pagead\/(?:viewthroughconversion|conversion|1p-[\w-]+)|rmkt|ccm|td)(?:\/|$)/;
const LIBRARY_PATH = /(?:^|\/)(?:gtag\/js|fbevents\.js|signals\/config\/[^/]*)$/;

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
  if (LIBRARY_PATH.test(url.pathname)) return false;
  if (COLLECTION_PATH.test(url.pathname)) return true;
  return !LOADS.has(req.resourceType);
}
