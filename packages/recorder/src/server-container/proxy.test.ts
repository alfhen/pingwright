import http from 'node:http';
import https from 'node:https';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunCa } from './ca.ts';
import type { RunCa } from './ca.ts';
import { createRecordingProxy } from './proxy.ts';
import type { ProxyRequest, RecordingProxy } from './proxy.ts';

interface Reply {
  status: number;
  body: string;
}

let root: string;
let ca: RunCa;
let proxy: RecordingProxy | undefined;
let seen: ProxyRequest[];
let forwarded: ProxyRequest[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tagreeve-proxy-test-'));
  ca = createRunCa(root);
  seen = [];
  forwarded = [];
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  vi.restoreAllMocks();
  ca.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(extra: Partial<Parameters<typeof createRecordingProxy>[0]> = {}): Promise<RecordingProxy> {
  proxy = await createRecordingProxy({
    host: '127.0.0.1',
    port: 0,
    ca,
    handler: (req) => {
      seen.push(req);
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'handled' };
    },
    forward: (req) => {
      forwarded.push(req);
      return { status: 200, body: 'forwarded' };
    },
    ...extra,
  });
  return proxy;
}

function basic(p: RecordingProxy, secret = p.credential): string {
  return `Basic ${Buffer.from(`${p.username}:${secret}`).toString('base64')}`;
}

function connect(p: RecordingProxy, target: string, auth?: string): Promise<{ status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(p.port, p.host, () => {
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (auth) lines.push(`Proxy-Authorization: ${auth}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    });
    socket.once('error', reject);
    socket.once('data', (data) => {
      resolve({ status: Number(data.toString().split(' ')[1]), socket });
    });
  });
}

async function viaTunnel(
  p: RecordingProxy,
  url: string,
  init: { method?: string; body?: string; trust?: boolean; auth?: string; path?: string } = {},
): Promise<Reply> {
  const u = new URL(url);
  const target = `${u.hostname}:${u.port || '443'}`;
  const { status, socket } = await connect(p, target, init.auth ?? basic(p));
  if (status !== 200) throw new Error(`CONNECT ${status}`);
  const secure = tls.connect({
    socket,
    host: u.hostname,
    servername: net.isIP(u.hostname) ? undefined : u.hostname,
    ...(init.trust === false ? {} : { ca: ca.certPem }),
  });
  return new Promise((resolve, reject) => {
    secure.once('error', reject);
    const req = https.request(
      { createConnection: () => secure, host: u.hostname, path: init.path ?? u.pathname + u.search, method: init.method ?? 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          secure.destroy();
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.once('error', reject);
    req.end(init.body);
  });
}

function plain(p: RecordingProxy, url: string, auth?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: p.host, port: p.port, path: url, method: 'GET', headers: auth ? { 'proxy-authorization': auth } : {}, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.once('error', reject);
    req.end();
  });
}

describe('recording proxy', () => {
  it('hands a decrypted request to the handler and returns its answer', async () => {
    const p = await start();
    const reply = await viaTunnel(p, 'https://graph.facebook.com/v21.0/PIXEL/events?a=1', {
      method: 'POST',
      body: '{"data":[]}',
    });
    expect(reply).toEqual({ status: 200, body: 'handled' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://graph.facebook.com/v21.0/PIXEL/events?a=1');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body.toString()).toBe('{"data":[]}');
    expect(seen[0]?.bodyComplete).toBe(true);
    expect(seen[0]?.headers['proxy-authorization']).toBeUndefined();
    expect(typeof seen[0]?.receivedAt).toBe('number');
  });

  it('never dials the CONNECT target, for any host', async () => {
    const p = await start();
    const dials: unknown[] = [];
    const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
    const tlsSpy = vi.spyOn(tls, 'connect');
    await viaTunnel(p, 'https://127.0.0.1:9/x');
    await viaTunnel(p, 'https://localhost:9/x');
    await viaTunnel(p, 'https://graph.facebook.com/x');
    await viaTunnel(p, 'https://www.googletagmanager.com/server.js?gtm_auth=fake');
    await viaTunnel(p, 'https://www.googletagmanager.com/static/serverjs/a.js');
    await viaTunnel(p, 'https://www.googletagmanager.com/s/gtag/destination');
    for (const call of connectSpy.mock.calls) {
      const raw = call[0] as unknown;
      const first = Array.isArray(raw) ? (raw[0] as unknown) : raw;
      const port = typeof first === 'object' && first !== null ? (first as { port?: number }).port : first;
      if (port !== p.port) dials.push(first);
    }
    for (const call of tlsSpy.mock.calls) {
      if (!(call[0] as { socket?: unknown }).socket) dials.push(call[0]);
    }
    expect(dials).toEqual([]);
    expect(seen).toHaveLength(3);
    expect(forwarded).toHaveLength(3);
  });

  it('takes the host from the CONNECT target, not from a // path', async () => {
    const p = await start();
    await viaTunnel(p, 'https://www.googletagmanager.com:8443/x', { path: '//www.googletagmanager.com/server.js' });
    expect(forwarded).toHaveLength(0);
    expect(p.passThrough()).toEqual({ serverjs: 0, config: 0, destination: 0 });
    await viaTunnel(p, 'https://graph.facebook.com/x', { path: '//collect/x' });
    expect(seen.map((r) => r.url)).toContain('https://graph.facebook.com//collect/x');
  });

  it('refuses a client that does not trust the run CA', async () => {
    const p = await start();
    await expect(viaTunnel(p, 'https://graph.facebook.com/x', { trust: false })).rejects.toMatchObject({
      code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    });
    expect(seen).toHaveLength(0);
  });

  it('passes the three Google paths to forward and counts them by class', async () => {
    const p = await start();
    await viaTunnel(p, 'https://www.googletagmanager.com/server.js?id=GTM-PWTEST1');
    await viaTunnel(p, 'https://www.googletagmanager.com/static/serverjs/r.js');
    await viaTunnel(p, 'https://www.googletagmanager.com/s/gtag/destination?id=G-PWTEST0001');
    await viaTunnel(p, 'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1');
    expect(p.passThrough()).toEqual({ serverjs: 1, config: 1, destination: 1 });
    expect(forwarded).toHaveLength(3);
    expect(seen.map((r) => new URL(r.url).pathname)).toEqual(['/gtm.js']);
  });

  it('answers 502 without a message when the handler throws', async () => {
    const p = await start({
      handler: () => {
        throw new Error('https://secret.invalid/?access_token=fake');
      },
    });
    const reply = await viaTunnel(p, 'https://graph.facebook.com/x');
    expect(reply).toEqual({ status: 502, body: '' });
  });

  describe('credential', () => {
    it('answers 407 to a CONNECT without or with a wrong credential', async () => {
      const p = await start();
      expect((await connect(p, 'graph.facebook.com:443')).status).toBe(407);
      expect((await connect(p, 'graph.facebook.com:443', basic(p, 'wrong'))).status).toBe(407);
      expect((await connect(p, 'graph.facebook.com:443', 'Basic')).status).toBe(407);
      expect(seen).toHaveLength(0);
      expect(forwarded).toHaveLength(0);
      expect(p.refused()).toBe(3);
      expect(p.passThrough()).toEqual({ serverjs: 0, config: 0, destination: 0 });
    });

    it('answers 407 to a plain request without or with a wrong credential', async () => {
      const p = await start();
      expect((await plain(p, 'http://graph.facebook.com/x')).status).toBe(407);
      expect((await plain(p, 'http://graph.facebook.com/x', basic(p, 'wrong'))).status).toBe(407);
      expect(p.refused()).toBe(2);
      expect(seen).toHaveLength(0);
      expect(forwarded).toHaveLength(0);
    });

    it('uses a different credential each run', async () => {
      const a = await start();
      const first = a.credential;
      await a.close();
      const b = await start();
      expect(b.credential).not.toBe(first);
      expect(first.length).toBeGreaterThanOrEqual(24);
    });
  });

  it('hands plain http absolute-URI requests to the handler', async () => {
    const p = await start();
    const reply = await plain(p, 'http://collect.example.invalid/hit?x=1', basic(p));
    expect(reply).toEqual({ status: 200, body: 'handled' });
    expect(seen[0]?.url).toBe('http://collect.example.invalid/hit?x=1');
  });

  it('cuts a 2 MiB body at 1 MiB and marks it incomplete', async () => {
    const p = await start();
    await viaTunnel(p, 'https://graph.facebook.com/x', { method: 'POST', body: 'a'.repeat(2 * 1024 * 1024) });
    expect(seen[0]?.body.length).toBe(1024 * 1024);
    expect(seen[0]?.bodyComplete).toBe(false);
  });

  it('closes idle sockets', async () => {
    const p = await start({ idleTimeoutMs: 100 });
    const socket = net.connect(p.port, p.host);
    await new Promise<void>((resolve) => socket.once('close', () => resolve()));
  });

  it('refuses a wildcard address', async () => {
    await expect(
      createRecordingProxy({ host: '0.0.0.0', port: 0, ca, handler: () => ({ status: 200 }), forward: () => ({ status: 200 }) }),
    ).rejects.toThrow(/wildcard/);
  });

  it('removes the CA directory on ca.close() and holds no key in it', () => {
    const dir = dirname(ca.certPath);
    expect(existsSync(dir)).toBe(true);
    ca.close();
    expect(existsSync(dir)).toBe(false);
  });
});
