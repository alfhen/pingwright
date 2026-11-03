import { tmpdir } from 'node:os';
import {
  MAX_POST_DATA,
  newId,
  nodeNow,
  type Id,
  type Request,
  type Response,
  type ServerContainerPassThrough,
} from '@tagreeve/core';
import { isLoopbackHost } from '../guard.ts';
import { redactHeaders, redactSecretsInBody, redactSecretsInUrl } from '../redact.ts';
import { stubResponse } from '../stub.ts';
import { createRunCa } from './ca.ts';
import type { RunCa } from './ca.ts';
import { createRecordingProxy } from './proxy.ts';
import type { ProxyRequest, ProxyResponse, RecordingProxy } from './proxy.ts';
import { describeImage, findProxyListenHost, resolveStandInCommand, ServerContainerUsageError, startServerContainer, TEST_COMMAND_ENV } from './runner.ts';
import type { ConfigSource, ServerContainer } from './runner.ts';

export const TEST_UPSTREAM_ENV = 'TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM';
export const GOOGLE_ORIGIN = 'https://www.googletagmanager.com';

/** The recorder waits until no container call has arrived for this long, but not longer than the maximum. */
export const QUIET_MS = 1000;
export const MAX_QUIET_WAIT_MS = 5000;

const FORWARD_TIMEOUT_MS = 30_000;
const STAND_IN_IMAGE = 'stand-in';

function flattenHeaders(headers: ProxyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

export interface CaptureContext {
  readonly runId: Id<'run'>;
  readonly stepId: Id<'stp'> | null;
}

/** Turns a call the container made into a request record. Secrets are replaced before anything else reads it. */
export function captureServerContainerCall(call: ProxyRequest, context: CaptureContext): Request {
  const text = call.body.length === 0 ? null : call.body.toString('utf8');
  return {
    type: 'request',
    id: newId('request'),
    runId: context.runId,
    stepId: context.stepId,
    t: call.receivedAt,
    method: call.method,
    url: redactSecretsInUrl(call.url),
    resourceType: 'fetch',
    frameUrl: null,
    initiator: 'serverContainer',
    headers: redactHeaders(flattenHeaders(call.headers)),
    postData: text === null ? null : redactSecretsInBody(text).slice(0, MAX_POST_DATA),
    outcome: 'stubbed',
    captured: 'serverContainer',
  };
}

/** The answer stub mode would give the vendor. Nothing is forwarded. */
export function serverContainerAnswer(request: Pick<Request, 'url'>): ProxyResponse {
  const stub = stubResponse({ resourceType: 'fetch', headers: {}, url: request.url });
  return { status: stub.status, headers: stub.headers, ...(stub.body ? { body: stub.body } : {}) };
}

/**
 * The origin that the forward function sends the three Google requests to. The stand-in seam may point it at a
 * loopback server. The value is never printed, because the message of a bad one must not hold it.
 */
export function resolveUpstreamOrigin(env: NodeJS.ProcessEnv, serverHosts: readonly string[]): string {
  const value = env[TEST_UPSTREAM_ENV];
  if (value === undefined || value === '') return GOOGLE_ORIGIN;
  const reject = (reason: string): never => {
    throw new ServerContainerUsageError(`${TEST_UPSTREAM_ENV} is not usable: ${reason}.`);
  };
  if (resolveStandInCommand(env, serverHosts) === undefined) reject(`it works only with ${TEST_COMMAND_ENV}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject('it must be an http:// origin');
  }
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) reject('it must be an http:// origin');
  if (!isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ''))) reject('it must be a loopback origin');
  return url.origin;
}

/**
 * The only way a request leaves the machine. It takes the path and query of a request the forward list matched and
 * nothing else from the container, and it stores nothing.
 */
export function createForward(origin: string, doFetch: typeof fetch = fetch): (request: ProxyRequest) => Promise<ProxyResponse> {
  return async (request) => {
    const matched = new URL(request.url);
    const response = await doFetch(`${origin}${matched.pathname}${matched.search}`, {
      method: request.method,
      headers: { accept: '*/*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const headers: Record<string, string> = {};
    for (const name of ['content-type', 'cache-control']) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
  };
}

/** Resolves once no call has arrived for `quietMs`, or after `maxMs`. */
export async function waitForQuiet(
  lastCallAt: () => number,
  options: { quietMs?: number; maxMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const { quietMs = QUIET_MS, maxMs = MAX_QUIET_WAIT_MS, now = Date.now, sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)) } = options;
  const start = now();
  for (;;) {
    const at = now();
    const remaining = Math.max(lastCallAt(), start) + quietMs - at;
    if (remaining <= 0 || at >= start + maxMs) return;
    await sleep(Math.min(remaining, start + maxMs - at));
  }
}

export interface SessionOptions {
  readonly configSource: ConfigSource;
  readonly image: string;
  readonly serverHosts: readonly string[];
  readonly runId: Id<'run'>;
  readonly currentStepId: () => Id<'stp'> | null;
  /** Called for each recorded call, with the answer the proxy gave. */
  readonly onCapture: (request: Request, response: Response) => void;
  readonly env?: NodeJS.ProcessEnv;
  readonly tempRoot?: string;
  readonly signal?: AbortSignal;
}

export interface ServerContainerSession {
  /** `http://127.0.0.1:<port>`: where the browser's requests go. */
  readonly origin: string;
  readonly image: string;
  readonly startedAt: number;
  /** True when the stand-in of the test seam ran. */
  readonly standIn: boolean;
  /** Calls recorded so far. */
  captured(): number;
  lastCallAt(): number;
  /** Later calls are still answered, but no longer recorded. */
  stopRecording(): void;
  /** True when the container ended before the run did. */
  containerExited(): boolean;
  passThrough(): ServerContainerPassThrough;
  refused(): number;
  stop(): Promise<void>;
}

/** Starts the CA, the recording proxy and the container. If any step fails, what started is stopped. */
export async function startServerContainerSession(options: SessionOptions): Promise<ServerContainerSession> {
  const env = options.env ?? process.env;
  const standIn = resolveStandInCommand(env, options.serverHosts) !== undefined;
  const upstream = resolveUpstreamOrigin(env, options.serverHosts);
  let ca: RunCa | undefined;
  let proxy: RecordingProxy | undefined;
  let container: ServerContainer | undefined;
  let recording = true;
  let captured = 0;
  let lastCallAt = 0;
  try {
    const listenHost = standIn ? '127.0.0.1' : await findProxyListenHost(env);
    ca = createRunCa(options.tempRoot ?? tmpdir());
    proxy = await createRecordingProxy({
      host: listenHost,
      port: 0,
      ca,
      forward: createForward(upstream),
      handler: (call) => {
        const answer = serverContainerAnswer({ url: call.url });
        if (recording) {
          const request = captureServerContainerCall(call, { runId: options.runId, stepId: options.currentStepId() });
          const response: Response = { type: 'response', id: newId('response'), requestId: request.id, status: answer.status, setCookieNames: [] };
          captured += 1;
          lastCallAt = Date.now();
          options.onCapture(request, response);
        }
        return answer;
      },
    });
    container = await startServerContainer({
      configSource: options.configSource,
      proxyPort: proxy.port,
      proxyHost: listenHost,
      proxyCredential: proxy.credential,
      proxyUsername: proxy.username,
      caPath: ca.certPath,
      image: options.image,
      serverHosts: options.serverHosts,
      env,
      ...(options.signal && { signal: options.signal }),
    });
    const image = standIn ? STAND_IN_IMAGE : await describeImage(options.image, env);
    const startedAt = nodeNow();
    const running = { ca, proxy, container };
    return {
      origin: container.origin,
      image,
      startedAt,
      standIn,
      captured: () => captured,
      lastCallAt: () => lastCallAt,
      containerExited: () => running.container.hasExited(),
      stopRecording: () => {
        recording = false;
      },
      passThrough: () => running.proxy.passThrough(),
      refused: () => running.proxy.refused(),
      async stop() {
        await running.container.stop().catch(() => undefined);
        await running.proxy.close().catch(() => undefined);
        running.ca.close();
      },
    };
  } catch (error) {
    await container?.stop().catch(() => undefined);
    await proxy?.close().catch(() => undefined);
    ca?.close();
    throw error;
  }
}
