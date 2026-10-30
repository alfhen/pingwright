import { rmSync } from 'node:fs';
import { newId, type Id, type Request, type Response, type Step } from '@pingwright/core';
import { isCollectionEndpoint, type TrackerEntry } from '@pingwright/decoders';
import { redactHeaders } from './redact.ts';
import { isKnownVendorCollection } from './stub.ts';

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

/** A frame's unload sends leave when a top-level navigation commits, shortly after it starts. */
const UNLOAD_WINDOW_MS = 5000;

/** Collection requests that the net log shows and no context hook saw. Each recorded request uses up one log entry of the same method and URL. */
export function mergeNetLog(
  entries: readonly NetLogRequest[],
  recorded: readonly Request[],
  steps: readonly Step[],
  trackers: readonly TrackerEntry[],
  runId: Id<'run'>,
  navigations: readonly number[] = [],
): { requests: Request[]; responses: Response[] } {
  const seen = new Map<string, number>();
  for (const r of recorded) {
    const key = `${r.method} ${r.url}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const requests: Request[] = [];
  const responses: Response[] = [];
  for (const entry of entries) {
    if (entry.method === 'OPTIONS') continue;
    const key = `${entry.method} ${entry.url}`;
    const count = seen.get(key) ?? 0;
    if (count > 0) {
      seen.set(key, count - 1);
      continue;
    }
    const candidate = { method: entry.method, url: entry.url, resourceType: 'other', postData: null } as Request;
    if (!/^https?:/.test(entry.url) || !(isCollectionEndpoint(candidate, trackers) || isKnownVendorCollection(candidate))) continue;
    const step = steps.findLast((s) => s.startedAt <= entry.t);
    const record: Request = {
      type: 'request',
      id: newId('request'),
      runId,
      stepId: step?.id ?? null,
      t: entry.t,
      method: entry.method,
      url: entry.url,
      resourceType: 'other',
      frameUrl: null,
      initiator: navigations.some((n) => n <= entry.t && entry.t - n <= UNLOAD_WINDOW_MS) ? 'unload' : 'netlog',
      headers: redactHeaders(entry.headers),
      postData: null,
      outcome: entry.failure ? 'failed' : 'passed',
      captured: 'netlog',
      ...(entry.failure ? { failure: entry.failure } : {}),
    };
    requests.push(record);
    if (entry.status !== null) responses.push({ type: 'response', id: newId('response'), requestId: record.id, status: entry.status, setCookieNames: [] });
  }
  return { requests, responses };
}

/**
 * Removes the directory when the process exits or gets SIGINT or SIGTERM, so a killed run leaves no net log
 * (it holds every URL of the session, unredacted). Returns the function that removes it now.
 */
export function watchNetLogDir(dir: string): () => void {
  const remove = (): void => {
    process.off('exit', remove);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    remove();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.on('exit', remove);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return remove;
}
