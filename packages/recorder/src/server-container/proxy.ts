import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import tls from 'node:tls';
import type { RunCa } from './ca.ts';
import { classifyForward } from './forward-list.ts';
import type { ForwardClass } from './forward-list.ts';

export interface ProxyRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  /** False when the body was longer than the limit and `body` holds only the start. */
  readonly bodyComplete: boolean;
  readonly receivedAt: number;
}

export interface ProxyResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
}

export type ProxyHandler = (request: ProxyRequest) => ProxyResponse | Promise<ProxyResponse>;

export interface RecordingProxyOptions {
  /** A loopback or private address. Never a wildcard address. */
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly ca: RunCa;
  readonly handler: ProxyHandler;
  /** The only way a request leaves the machine. Called for forward-list matches only. */
  readonly forward: ProxyHandler;
  readonly idleTimeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export type PassThroughCounts = Record<ForwardClass, number>;

export interface RecordingProxy {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  /** The per-run secret. Send it as the password of `Proxy-Authorization: Basic`. */
  readonly credential: string;
  passThrough(): PassThroughCounts;
  /** Requests answered 407 for a missing or wrong credential. */
  refused(): number;
  close(): Promise<void>;
}

const USERNAME = 'tagreeve';
const MAX_BODY_BYTES = 1024 * 1024;
const IDLE_TIMEOUT_MS = 30_000;
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '']);

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

interface Target {
  readonly hostname: string;
  readonly origin: string;
}

function parseConnectTarget(authority: string | undefined): Target | undefined {
  if (!authority) return undefined;
  try {
    const u = new URL(`https://${authority}`);
    if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return undefined;
    const port = u.port === '' ? '443' : u.port;
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    if (hostname === '') return undefined;
    return { hostname, origin: `https://${u.hostname}${port === '443' ? '' : `:${port}`}` };
  } catch {
    return undefined;
  }
}

export async function createRecordingProxy(options: RecordingProxyOptions): Promise<RecordingProxy> {
  if (WILDCARD_HOSTS.has(options.host)) throw new Error('The proxy must not listen on a wildcard address.');
  const credential = randomBytes(24).toString('base64url');
  const expected = digest(`Basic ${Buffer.from(`${USERNAME}:${credential}`).toString('base64')}`);
  const idleMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const maxBody = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const counts: PassThroughCounts = { serverjs: 0, config: 0, destination: 0 };
  let refusedCount = 0;
  const sockets = new Set<Duplex>();
  const tunnelTargets = new WeakMap<Duplex, Target>();
  const contexts = new Map<string, tls.SecureContext>();

  function track(socket: Duplex & { setTimeout?: (ms: number) => unknown }): void {
    sockets.add(socket);
    socket.setTimeout?.(idleMs);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  }

  function authorized(headers: IncomingHttpHeaders): boolean {
    const given = headers['proxy-authorization'];
    if (typeof given !== 'string') return false;
    return timingSafeEqual(digest(given), expected);
  }

  function reject407(res: ServerResponse): void {
    refusedCount += 1;
    res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="tagreeve"', 'Content-Length': '0', Connection: 'close' });
    res.end();
  }

  async function readBody(req: IncomingMessage): Promise<{ body: Buffer; complete: boolean }> {
    const chunks: Buffer[] = [];
    let size = 0;
    let complete = true;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      if (size >= maxBody) {
        complete = false;
        continue;
      }
      const room = maxBody - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) complete = false;
      chunks.push(part);
      size += part.length;
    }
    return { body: Buffer.concat(chunks), complete };
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const receivedAt = Date.now();
    const { body, complete } = await readBody(req);
    const headers = { ...req.headers };
    delete headers['proxy-authorization'];
    const request: ProxyRequest = {
      method: req.method ?? 'GET',
      url: url.href,
      headers,
      body,
      bodyComplete: complete,
      receivedAt,
    };
    let answer: ProxyResponse;
    try {
      const forwardClass = classifyForward(request.method, url);
      if (forwardClass) {
        counts[forwardClass] += 1;
        answer = await options.forward(request);
      } else {
        answer = await options.handler(request);
      }
    } catch {
      answer = { status: 502 };
    }
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  function onPlainRequest(req: IncomingMessage, res: ServerResponse): void {
    if (!authorized(req.headers)) {
      reject407(res);
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'Content-Length': '0' }).end();
      return;
    }
    if (url.protocol !== 'http:') {
      res.writeHead(400, { 'Content-Length': '0' }).end();
      return;
    }
    dispatch(req, res, url).catch(() => res.destroy());
  }

  function onTunnelRequest(req: IncomingMessage, res: ServerResponse): void {
    const target = tunnelTargets.get(req.socket);
    if (!target || !req.url?.startsWith('/')) {
      res.writeHead(400, { 'Content-Length': '0' }).end();
      return;
    }
    let url: URL;
    try {
      url = new URL(target.origin + req.url);
    } catch {
      res.writeHead(400, { 'Content-Length': '0' }).end();
      return;
    }
    if (url.origin !== target.origin) {
      res.writeHead(400, { 'Content-Length': '0' }).end();
      return;
    }
    dispatch(req, res, url).catch(() => res.destroy());
  }

  function secureContextFor(hostname: string): tls.SecureContext {
    let context = contexts.get(hostname);
    if (!context) {
      const leaf = options.ca.leafFor(hostname);
      context = tls.createSecureContext({ key: leaf.keyPem, cert: leaf.certPem });
      contexts.set(hostname, context);
    }
    return context;
  }

  const tunnelServer = http.createServer(onTunnelRequest);
  const server = http.createServer(onPlainRequest);

  // The target is never dialled: the client's TLS ends here, at a certificate from the run's CA.
  server.on('connect', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    track(socket);
    if (!authorized(req.headers)) {
      refusedCount += 1;
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="tagreeve"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const target = parseConnectTarget(req.url);
    if (!target) {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) socket.unshift(head);
    const secure = new tls.TLSSocket(socket as Socket, {
      isServer: true,
      secureContext: secureContextFor(target.hostname),
    });
    tunnelTargets.set(secure, target);
    track(secure);
    tunnelServer.emit('connection', secure);
  });
  server.on('connection', (socket) => track(socket));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    host: options.host,
    port,
    username: USERNAME,
    credential,
    passThrough: () => ({ ...counts }),
    refused: () => refusedCount,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
