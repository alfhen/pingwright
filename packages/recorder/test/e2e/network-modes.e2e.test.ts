import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { recordVisit, type RunResult } from '../../src/index.ts';

let server: Server;
let port: number;
let outDir: string;
let serverSaw: string[] = [];

const COLLECT = (tag: string) => `/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=${tag}`;

function page(path: string): string | undefined {
  const origin = `http://127.0.0.1:${port}`;
  switch (path) {
    case '/modes':
      return `<script>
        fetch('${origin}${COLLECT('fetch')}', { method: 'POST', body: 'x' });
        new Image().src = '${origin}${COLLECT('image')}';
        navigator.sendBeacon('${origin}${COLLECT('beacon')}', 'x');
      </script>`;
    case '/details':
      return `<script>
        fetch('/api?x=1', { method: 'POST', headers: { authorization: 'Bearer secret-token' }, body: 'a'.repeat(100000) });
        new Worker(URL.createObjectURL(new Blob(["fetch('${origin}/from-worker')"], { type: 'text/javascript' })));
      </script>`;
    case '/sw':
      return `<script>navigator.serviceWorker.register('/sw.js');</script>`;
    case '/early-srcdoc': {
      const inner = `<script>fetch('${origin}${COLLECT('early')}', { mode: 'no-cors' });</script>`;
      return `<iframe sandbox="allow-scripts" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`;
    }
    default:
      return undefined;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    serverSaw.push(req.url ?? '');
    const html = page(path);
    if (path === '/sw.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(`self.addEventListener('install', (e) => { e.waitUntil(fetch('http://127.0.0.1:${port}/from-sw')); });`);
    } else if (html) {
      res.setHeader('content-type', 'text/html');
      res.end(`<!doctype html><meta charset="utf-8"><title>t</title>${html}`);
    } else {
      res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'modes-'));
});

afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function visit(path: string, networkMode: 'stub' | 'live'): Promise<RunResult> {
  serverSaw = [];
  return recordVisit({
    networkMode,
    outDir,
    site: `http://localhost:${port}`,
    startUrl: `http://localhost:${port}${path}`,
    waitMs: 1000,
  });
}

const collectionRequests = (r: RunResult) => r.records.requests.filter((q) => q.url.includes('/g/collect'));

test('stub mode answers fetch, image and beacon collection requests locally and records them as stubbed', async () => {
  const { records } = await visit('/modes', 'stub');
  const requests = collectionRequests({ records } as RunResult);
  expect(requests.map((q) => q.resourceType).sort()).toEqual(['fetch', 'image', 'ping']);
  expect(requests.every((q) => q.outcome === 'stubbed')).toBe(true);
  expect(serverSaw.filter((u) => u.startsWith('/g/collect'))).toEqual([]);
  const statuses = new Map(
    records.responses.filter((res) => requests.some((q) => q.id === res.requestId)).map((res) => [res.requestId, res.status]),
  );
  const byType = Object.fromEntries(requests.map((q) => [q.resourceType, statuses.get(q.id)]));
  expect(byType).toEqual({ fetch: 204, image: 200, ping: 204 });
  expect(records.hits.map((h) => h.event).sort()).toEqual(['beacon', 'fetch', 'image']);
});

test('live mode passes the same requests through', async () => {
  const { records } = await visit('/modes', 'live');
  const requests = collectionRequests({ records } as RunResult);
  expect(requests).toHaveLength(3);
  expect(requests.every((q) => q.outcome === 'passed')).toBe(true);
  expect(serverSaw.filter((u) => u.startsWith('/g/collect'))).toHaveLength(3);
  expect(records.run.networkMode).toBe('live');
});

test('authorization is redacted, post data is capped, and dedicated worker requests are recorded', async () => {
  const { records } = await visit('/details', 'stub');
  const api = records.requests.find((q) => q.url.endsWith('/api?x=1'));
  expect(api?.headers.authorization).toBe('[redacted]');
  expect(JSON.stringify(api)).not.toContain('secret-token');
  expect(api?.postData).toHaveLength(64 * 1024);
  const worker = records.requests.find((q) => q.url.endsWith('/from-worker'));
  expect(worker?.outcome).toBe('passed');
});

test('service worker requests are recorded without a frame', async () => {
  const { records } = await visit('/sw', 'stub');
  const request = records.requests.find((q) => q.url.endsWith('/from-sw'));
  expect(request).toMatchObject({ frameUrl: null, initiator: 'serviceWorker', outcome: 'passed' });
});

// Documents a limit of context.route and context.on('request'). If Chromium changes this, update design 5.3.
test('a collection request sent while a sandboxed srcdoc iframe loads is neither recorded nor stubbed', async () => {
  const { records } = await visit('/early-srcdoc', 'stub');
  expect(collectionRequests({ records } as RunResult)).toEqual([]);
  expect(serverSaw.filter((u) => u.includes('en=early'))).toHaveLength(1);
});
