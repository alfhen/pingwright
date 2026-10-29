import type { BrowserContext } from 'playwright';
import { COLLECTOR_ORIGIN } from './origins.ts';
import { corsHeaders } from './stub.ts';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SOURCE_LENGTH = 64;

export type ParsedReport =
  | { ok: true; source: string; payload: Record<string, unknown> }
  | { ok: false; error: string };

/** A report is a JSON object with a non-empty string `source`. */
export function parseCollectorBody(body: string | null): ParsedReport {
  if (!body) return { ok: false, error: 'empty body' };
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) return { ok: false, error: `body over ${MAX_BODY_BYTES} bytes` };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: 'body is not JSON' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const payload = json as Record<string, unknown>;
  const source = payload.source;
  if (typeof source !== 'string' || source === '' || source.length > MAX_SOURCE_LENGTH) {
    return { ok: false, error: `"source" must be a string of 1 to ${MAX_SOURCE_LENGTH} characters` };
  }
  return { ok: true, source, payload };
}

/** What the handler gets for a request that is not a POST: the method and URL, so the hit is not lost. */
export function parseCollectorRequest(method: string, url: string, body: string | null): { parsed: ParsedReport; body: string } {
  if (method === 'POST') return { parsed: parseCollectorBody(body), body: body ?? '' };
  return { parsed: { ok: false, error: `${method} request, reports must be POST` }, body: url };
}

export type CollectorHandler = (parsed: ParsedReport, body: string, t: number) => void;

/**
 * Answers the collector origin with 204. Reports go to the handler and are never forwarded.
 * The handler is looked up per request so the recorder can swap it after the self-test.
 */
export async function routeCollector(
  context: BrowserContext,
  handler: () => CollectorHandler,
  now: () => number,
): Promise<void> {
  await context.route(`${COLLECTOR_ORIGIN}/**`, async (route) => {
    const request = route.request();
    // A preflight is the browser's own request, not a report.
    if (request.method() !== 'OPTIONS') {
      const { parsed, body } = parseCollectorRequest(request.method(), request.url(), request.postData());
      handler()(parsed, body, now());
    }
    await route.fulfill({ status: 204, headers: corsHeaders(request.headers()) });
  });
}
