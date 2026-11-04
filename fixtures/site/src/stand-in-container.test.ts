import net from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { createRunCa } from '../../../packages/recorder/src/server-container/ca.ts';
import type { RunCa } from '../../../packages/recorder/src/server-container/ca.ts';
import { createRecordingProxy } from '../../../packages/recorder/src/server-container/proxy.ts';
import type { ProxyRequest, RecordingProxy } from '../../../packages/recorder/src/server-container/proxy.ts';
import { standInContainerPath } from './index.ts';
import { FIXTURE_AUTH, FIXTURE_CONFIG, createStandIn } from './stand-in-container.ts';

let root: string;
let ca: RunCa;
let proxy: RecordingProxy;
let answered: ProxyRequest[];
let forwarded: ProxyRequest[];
let standIn: ReturnType<typeof createStandIn> | undefined;
let errorSpy: MockInstance<typeof console.error>;

beforeEach(async () => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), 'tagreeve-stand-in-test-'));
  ca = createRunCa(root);
  answered = [];
  forwarded = [];
  proxy = await createRecordingProxy({
    host: '127.0.0.1',
    port: 0,
    ca,
    handler: (req) => {
      answered.push(req);
      return { status: 200, body: '{"events_received":1}' };
    },
    forward: (req) => {
      forwarded.push(req);
      return { status: 200, body: '// fake' };
    },
  });
});

afterEach(async () => {
  await standIn?.close();
  standIn = undefined;
  errorSpy.mockRestore();
  await proxy.close();
  ca.close();
  rmSync(root, { recursive: true, force: true });
});

async function start(env: Partial<{ HTTP_PROXY: string; NODE_EXTRA_CA_CERTS: string }> = {}): Promise<string> {
  standIn = createStandIn({ HTTP_PROXY: `http://${proxy.username}:${proxy.credential}@127.0.0.1:${proxy.port}`, NODE_EXTRA_CA_CERTS: ca.certPath, PORT: '0', ...env });
  const port = await standIn.listen();
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100 && (await fetch(`${origin}/healthz`)).status !== 200; i++) await new Promise((r) => setTimeout(r, 20));
  return origin;
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

describe('stand-in container', () => {
  it('is an executable file', () => {
    expect(statSync(standInContainerPath).mode & 0o111).not.toBe(0);
  });

  it('fetches the container config and the destination file at start, through the forward list', async () => {
    await start();
    expect(forwarded.map((r) => new URL(r.url).pathname)).toEqual(['/server.js', '/s/gtag/destination']);
    expect(new URL(forwarded[0]!.url).searchParams.get('gtm_auth')).toBe('pw-fixture-auth');
    expect(answered).toEqual([]);
  });

  it.each(['/g/collect', '/pixel', '/capi'])('answers a POST to %s and then makes the three vendor calls', async (path) => {
    const origin = await start();
    const reply = await fetch(`${origin}${path}`, { method: 'POST', body: JSON.stringify({ event_name: 'Purchase', event_id: 'evt-77', email: 'Pw.Fixture@example.invalid' }) });
    expect(reply.status).toBe(200);
    await until(() => answered.length === 3);
    expect(answered.map((r) => `${r.method} ${new URL(r.url).host}${new URL(r.url).pathname}`)).toEqual([
      'POST www.google-analytics.com/g/collect',
      'GET www.googleadservices.com/pagead/conversion/000000001/',
      'POST graph.facebook.com/v21.0/100000000000001/events',
    ]);
    const capi = JSON.parse(answered[2]!.body.toString('utf8')) as { data: Array<{ event_name: string; event_id: string; user_data: { em: string[] } }> };
    expect(capi.data[0]!.event_name).toBe('Purchase');
    expect(capi.data[0]!.event_id).toBe('evt-77');
    expect(capi.data[0]!.user_data.em[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(answered[0]!.body.toString('utf8')).toContain('evt-77');
  });

  it('delays the vendor calls by delayMs after it has answered', async () => {
    const origin = await start();
    const started = Date.now();
    await fetch(`${origin}/capi?delayMs=400`, { method: 'POST', body: '{}' });
    expect(Date.now() - started).toBeLessThan(300);
    expect(answered).toEqual([]);
    await until(() => answered.length === 3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it('caps the delay at 5000 ms', async () => {
    const origin = await start();
    await fetch(`${origin}/capi?delayMs=900000`, { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 300));
    expect(answered).toEqual([]);
  });

  it('answers 404 to other paths', async () => {
    const origin = await start();
    expect((await fetch(`${origin}/data`, { method: 'POST', body: '{}' })).status).toBe(404);
  });

  it('honours only the upper-case proxy variable: with none it sends nothing anywhere', async () => {
    forwarded.length = 0;
    const origin = await start({ HTTP_PROXY: undefined });
    await fetch(`${origin}/capi`, { method: 'POST', body: '{}' });
    await new Promise((r) => setTimeout(r, 300));
    expect(forwarded).toEqual([]);
    expect(answered).toEqual([]);
  });

  it('rejects a certificate from another CA', async () => {
    const other = createRunCa(root);
    try {
      const origin = await start({ NODE_EXTRA_CA_CERTS: other.certPath });
      await fetch(`${origin}/capi`, { method: 'POST', body: '{}' });
      await new Promise((r) => setTimeout(r, 300));
      expect(answered).toEqual([]);
    } finally {
      other.close();
    }
  });

  it('logs what a careless container would: the config, the proxy URL, the auth URL and the access token URL', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)));
    try {
      const origin = await start();
      await fetch(`${origin}/capi`, { method: 'POST', body: '{}' });
      await until(() => answered.length === 3);
      const logged = lines.join('\n');
      expect(logged).toContain(FIXTURE_CONFIG);
      expect(logged).toContain(`gtm_auth=${FIXTURE_AUTH}`);
      expect(logged).toContain(`:${proxy.credential}@127.0.0.1:${proxy.port}`);
      expect(logged).toContain('access_token=pw-fixture-access-token');
    } finally {
      spy.mockRestore();
    }
  });

  it('reads the CA once at start: deleting the file later breaks nothing', async () => {
    const origin = await start();
    rmSync(ca.certPath);
    await fetch(`${origin}/capi`, { method: 'POST', body: '{}' });
    await until(() => answered.length === 3);
    expect(answered).toHaveLength(3);
  });

  it('close waits for a vendor call that is under way', async () => {
    const origin = await start();
    await fetch(`${origin}/capi`, { method: 'POST', body: '{}' });
    await until(() => answered.length >= 1);
    await standIn!.close();
    expect(answered).toHaveLength(3);
  });

  it('close drops vendor calls that are still waiting for their delay', async () => {
    const origin = await start();
    await fetch(`${origin}/capi?delayMs=300`, { method: 'POST', body: '{}' });
    await standIn!.close();
    await new Promise((r) => setTimeout(r, 450));
    expect(answered).toEqual([]);
  });

  describe('a proxy that accepts the connection and never answers', () => {
    let stalled: net.Server;
    let sockets: net.Socket[];
    let stalledPort: number;

    beforeEach(async () => {
      sockets = [];
      stalled = net.createServer((socket) => {
        sockets.push(socket);
        socket.on('error', () => {});
        socket.resume();
      });
      await new Promise<void>((resolve) => stalled.listen(0, '127.0.0.1', resolve));
      stalledPort = (stalled.address() as net.AddressInfo).port;
    });

    afterEach(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    });

    function startStalled(socketTimeoutMs?: number): Promise<number> {
      standIn = createStandIn({ HTTP_PROXY: `http://u:p@127.0.0.1:${stalledPort}`, NODE_EXTRA_CA_CERTS: ca.certPath, PORT: '0' }, { socketTimeoutMs });
      return standIn.listen();
    }

    it('rejects each call after the socket timeout, so start-up finishes', async () => {
      const started = Date.now();
      const port = await startStalled(150);
      const origin = `http://127.0.0.1:${port}`;
      for (let i = 0; i < 100 && (await fetch(`${origin}/healthz`)).status !== 200; i++) await new Promise((r) => setTimeout(r, 20));
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(Date.now() - started).toBeLessThan(2000);
      const lines = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line === 'Fetch failed: the proxy call timed out')).toHaveLength(2);
    });

    it('close gives up after 2 s and destroys the open sockets', async () => {
      await startStalled(60_000);
      await until(() => sockets.length === 1);
      expect(sockets).toHaveLength(1);
      const started = Date.now();
      await standIn!.close();
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(1900);
      expect(took).toBeLessThan(4000);
      await until(() => sockets[0]!.destroyed);
      expect(sockets[0]!.destroyed).toBe(true);
    });
  });
});
