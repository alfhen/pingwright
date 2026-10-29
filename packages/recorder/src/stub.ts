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

/** A 1x1 GIF for images, 204 for everything else. */
export function stubResponse(req: Pick<Request, 'resourceType' | 'headers'>): StubResponse {
  const cors = corsHeaders(req.headers);
  if (req.resourceType === 'image') {
    return { status: 200, headers: { ...cors, 'content-type': 'image/gif', 'cache-control': 'no-store' }, body: GIF };
  }
  return { status: 204, headers: cors };
}

/**
 * Collection paths of vendors whose decoders may not be registered. Stub mode must never let these leave the
 * machine, whatever the registry holds.
 */
export function isKnownVendorCollection(req: Pick<Request, 'url'>): boolean {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return false;
  }
  const host = u.hostname;
  if (/(^|\.)facebook\.com$/.test(host)) return /^\/tr\/?$/.test(u.pathname);
  if (/(^|\.)(googleadservices|doubleclick|googlesyndication)\.(com|net)$|^(www\.)?google\.com$/.test(host)) {
    return /^\/(ccm\/collect|pagead\/)/.test(u.pathname);
  }
  return false;
}
