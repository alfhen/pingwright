#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

export const FIXTURE_AUTH = 'pw-fixture-auth';
const CONTAINER_URL = `https://www.googletagmanager.com/server.js?id=GTM-PWTEST1&gtm_auth=${FIXTURE_AUTH}`;
const DESTINATION_URL = 'https://www.googletagmanager.com/s/gtag/destination?id=G-PWTEST0001';
const TRIGGER_PATHS = new Set(['/g/collect', '/pixel', '/capi']);
const MAX_DELAY_MS = 5000;
const SOCKET_TIMEOUT_MS = 10_000;
const CLOSE_WAIT_MS = 2000;
export const FIXTURE_CONFIG = Buffer.from(`id=GTM-PWTEST1&env=1&auth=${FIXTURE_AUTH}`).toString('base64');

export interface StandInEnv {
  readonly HTTP_PROXY?: string;
  readonly NODE_EXTRA_CA_CERTS?: string;
  readonly PORT?: string;
}

interface Reply {
  readonly status: number;
  readonly body: string;
}

interface HitFields {
  eventName: string;
  eventId: string;
  email: string;
  clientId: string | undefined;
  copyGa4: boolean;
}

/**
 * Stands in for a real server container without Docker. Like the real image it reads only the
 * upper-case HTTP_PROXY, tunnels with CONNECT, and trusts only NODE_EXTRA_CA_CERTS.
 */
export function createStandIn(env: StandInEnv, options: { readonly socketTimeoutMs?: number } = {}): { listen(): Promise<number>; close(): Promise<void> } {
  const proxyUrl = env.HTTP_PROXY ? new URL(env.HTTP_PROXY) : undefined;
  let ready = false;
  const pending = new Set<Promise<unknown>>();
  const timers = new Set<NodeJS.Timeout>();
  const open = new Set<{ destroy(): unknown }>();
  const socketTimeoutMs = options.socketTimeoutMs ?? SOCKET_TIMEOUT_MS;
  let closing = false;
  let ca: string | undefined;

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  }

  function viaProxy(method: string, target: string, body?: string): Promise<Reply> {
    return new Promise((resolveReply, rejectReply) => {
      if (!proxyUrl || ca === undefined) {
        rejectReply(new Error('HTTP_PROXY and NODE_EXTRA_CA_CERTS are needed'));
        return;
      }
      if (closing) {
        rejectReply(new Error('the stand-in is closing'));
        return;
      }
      const parts = new Set<{ destroy(): unknown }>();
      const use = <T extends { destroy(): unknown }>(part: T): T => {
        parts.add(part);
        open.add(part);
        return part;
      };
      const release = () => {
        clearTimeout(timer);
        for (const part of parts) open.delete(part);
      };
      const resolve = (reply: Reply) => {
        release();
        resolveReply(reply);
      };
      const reject = (error: Error) => {
        release();
        rejectReply(error);
      };
      const timer = setTimeout(() => {
        reject(new Error('the proxy call timed out'));
        for (const part of parts) part.destroy();
      }, socketTimeoutMs);
      const url = new URL(target);
      const auth = Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64');
      const connect = use(http.request({
        host: proxyUrl.hostname,
        port: Number(proxyUrl.port),
        method: 'CONNECT',
        path: `${url.hostname}:443`,
        headers: { 'Proxy-Authorization': `Basic ${auth}` },
      }));
      connect.on('error', reject);
      connect.on('connect', (response, socket) => {
        use(socket);
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`the proxy answered ${response.statusCode}`));
          return;
        }
        const secure = use(tls.connect({ socket, host: url.hostname, servername: url.hostname, ca }));
        secure.on('error', reject);
        const headers: Record<string, string | number> = body === undefined ? {} : { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) };
        // The agent hands out only the tunnel, and the lookup fails, so a request can never open a direct connection.
        const agent = new http.Agent({ keepAlive: false });
        agent.createConnection = () => secure;
        const refuseLookup: net.LookupFunction = (_host, _options, callback) => callback(new Error('direct connections are not allowed'), '', 4);
        const request = http.request({ agent, lookup: refuseLookup, method, host: url.hostname, path: url.pathname + url.search, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            secure.destroy();
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        request.on('error', (error) => {
          secure.destroy();
          reject(error);
        });
        request.end(body);
      });
      connect.end();
    });
  }

  async function startUp(): Promise<void> {
    // These lines are what a careless container would log; the runner's scrub has to remove them.
    console.error(`Config ${FIXTURE_CONFIG}`);
    console.error(`Proxy ${env.HTTP_PROXY ?? 'none'}`);
    for (const url of [CONTAINER_URL, DESTINATION_URL]) {
      console.error(`Fetching ${url}`);
      try {
        const reply = await viaProxy('GET', url);
        console.error(`Answered ${reply.status}`);
      } catch (error) {
        console.error(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ready = true;
  }

  function fieldsOf(url: URL, body: string): HitFields {
    const copyGa4 = url.searchParams.get('ga4') === 'copy';
    const values = new Map<string, string>(url.searchParams);
    try {
      const json: unknown = JSON.parse(body);
      if (json && typeof json === 'object') {
        for (const [key, value] of Object.entries(json)) if (typeof value === 'string') values.set(key, value);
      }
    } catch {
      for (const [key, value] of new URLSearchParams(body)) values.set(key, value);
    }
    const pick = (...names: string[]) => names.map((name) => values.get(name)).find((value) => value !== undefined && value !== '');
    return {
      eventName: pick('event_name', 'ev', 'en') ?? 'Purchase',
      eventId: pick('event_id', 'eid') ?? 'pw-event-1',
      email: pick('email', 'em') ?? 'pw-fixture@example.invalid',
      clientId: copyGa4 ? pick('cid', 'client_id') : undefined,
      copyGa4,
    };
  }

  async function sendVendorCalls(fields: HitFields): Promise<void> {
    const hashed = /^[0-9a-f]{64}$/.test(fields.email) ? fields.email : createHash('sha256').update(fields.email.trim().toLowerCase()).digest('hex');
    const capi = JSON.stringify({
      data: [
        {
          event_name: fields.eventName,
          event_time: 1_700_000_000,
          event_id: fields.eventId,
          action_source: 'website',
          user_data: { em: [hashed] },
        },
      ],
    });
    const ga4Body = `en=${encodeURIComponent(fields.eventName)}${fields.copyGa4 ? '' : `&ep.event_id=${encodeURIComponent(fields.eventId)}`}`;
    const calls: Array<[string, string, string | undefined]> = [
      ['POST', `https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=${encodeURIComponent(fields.clientId ?? 'pw-client.1')}&en=${encodeURIComponent(fields.eventName)}`, ga4Body],
      ['GET', `https://www.googleadservices.com/pagead/conversion/000000001/?label=pw-label&oid=${encodeURIComponent(fields.eventId)}`, undefined],
      ['POST', 'https://graph.facebook.com/v21.0/100000000000001/events?access_token=pw-fixture-access-token', capi],
    ];
    for (const [method, url, body] of calls) {
      console.error(`Calling ${url}`);
      await viaProxy(method, url, body).catch((error: unknown) => {
        console.error(`Vendor call failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stand-in.invalid');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(ready ? 200 : 503).end();
      return;
    }
    if (req.method !== 'POST' || !TRIGGER_PATHS.has(url.pathname)) {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const answerAfter = url.searchParams.get('answer') === 'after';
      const answer = () => {
        if (!res.writableEnded) res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      };
      if (!answerAfter) answer();
      const asked = Number(url.searchParams.get('delayMs') ?? 0);
      const delay = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 0), MAX_DELAY_MS) : 0;
      const fields = fieldsOf(url, Buffer.concat(chunks).toString('utf8'));
      const timer = setTimeout(() => {
        timers.delete(timer);
        void track(sendVendorCalls(fields).finally(answer));
      }, delay);
      timers.add(timer);
    });
  });

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(Number(env.PORT ?? 0), '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : 0);
          if (env.NODE_EXTRA_CA_CERTS) {
            try {
              ca = readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8');
            } catch (error) {
              console.error(`The CA file could not be read: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          void track(startUp());
        });
      }),
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const drained = (async () => {
        while (pending.size > 0) await Promise.allSettled([...pending]);
      })();
      let giveUp: NodeJS.Timeout | undefined;
      const patience = new Promise<void>((resolve) => {
        giveUp = setTimeout(resolve, CLOSE_WAIT_MS);
      });
      await Promise.race([drained, patience]);
      clearTimeout(giveUp);
      closing = true;
      for (const part of open) part.destroy();
      await drained;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

const entry = process.argv[1];
if (entry && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const standIn = createStandIn(process.env as StandInEnv);
  await standIn.listen();
  process.on('SIGTERM', () => void standIn.close().then(() => process.exit(0)));
}
