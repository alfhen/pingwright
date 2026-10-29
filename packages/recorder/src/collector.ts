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
    if (request.method() === 'POST') {
      const body = request.postData() ?? '';
      handler()(parseCollectorBody(body), body, now());
    }
    await route.fulfill({ status: 204, headers: corsHeaders(request.headers()) });
  });
}
