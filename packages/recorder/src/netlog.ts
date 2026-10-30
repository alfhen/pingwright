export interface NetLogRequest {
  t: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  status: number | null;
  failure: string | null;
}

interface NetLogEvent {
  type: number;
  time: string;
  source: { id: number };
  params?: Record<string, unknown>;
}

interface NetLogFile {
  constants: { logEventTypes: Record<string, number>; netError: Record<string, number>; timeTickOffset: number | string };
  events: NetLogEvent[];
}

function parseFile(text: string): NetLogFile {
  try {
    return JSON.parse(text) as NetLogFile;
  } catch {
    // A log that was not closed cleanly stops after the last event.
    return JSON.parse(text.replace(/,?\s*$/, '') + ']}') as NetLogFile;
  }
}

function headerMap(lines: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(lines)) return out;
  for (const line of lines) {
    if (typeof line !== 'string') continue;
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

/**
 * Reads the URL requests of a Chromium net log: URL, method, request headers (cookies are already stripped at the
 * default capture mode), response status and network error. Bodies are not in the log.
 */
export function parseNetLog(text: string): NetLogRequest[] {
  const { constants, events } = parseFile(text);
  const types = constants.logEventTypes;
  const errorNames = new Map(Object.entries(constants.netError).map(([name, code]) => [code, name]));
  const offset = Number(constants.timeTickOffset);
  const bySource = new Map<number, NetLogRequest>();
  for (const event of events) {
    const params = event.params ?? {};
    const id = event.source.id;
    if (event.type === types.URL_REQUEST_START_JOB && typeof params.url === 'string') {
      const method = typeof params.method === 'string' ? params.method : 'GET';
      if (bySource.has(id) || method === 'OPTIONS') continue;
      bySource.set(id, {
        t: Number(event.time) + offset,
        method,
        url: params.url,
        headers: {},
        status: null,
        failure: null,
      });
      continue;
    }
    const entry = bySource.get(id);
    if (!entry) continue;
    if (event.type === types.HTTP_TRANSACTION_SEND_REQUEST_HEADERS) {
      entry.headers = headerMap(params.headers);
    } else if (event.type === types.HTTP_TRANSACTION_READ_RESPONSE_HEADERS && Array.isArray(params.headers)) {
      const status = /^HTTP\/\S+\s+(\d{3})/.exec(String(params.headers[0]));
      if (status) entry.status = Number(status[1]);
    } else if (typeof params.net_error === 'number' && params.net_error !== 0 && entry.failure === null) {
      const name = errorNames.get(params.net_error);
      if (name) entry.failure = `net::${name}`;
    }
  }
  return [...bySource.values()];
}
