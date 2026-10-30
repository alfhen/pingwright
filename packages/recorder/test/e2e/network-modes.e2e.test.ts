import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { decodeRequest } from '@pingwright/decoders';
import { launchRecorder, recordVisit, type RunResult } from '../../src/index.ts';

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
    case '/worker-collect':
      return `<script>
        new Worker(URL.createObjectURL(new Blob(["fetch('${origin}${COLLECT('worker')}', { method: 'POST', body: 'x' })"], { type: 'text/javascript' })));
      </script>`;
    case '/redirect':
      return `<script>fetch('${origin}/redirect-to-collect', { mode: 'no-cors' });</script>`;
    case '/collector-get':
      return `<script>new Image().src = 'https://collector.pingwright.invalid/pixel.gif?source=get-pixel';</script>`;
    case '/frame-consent':
      return `<script>
        window.dataLayer = window.dataLayer || [];
        function gtag() { dataLayer.push(arguments); }
        gtag('consent', 'default', { ad_storage: 'denied', analytics_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      </script><iframe src="/frame-consent-inner"></iframe>`;
    case '/frame-consent-inner':
      return `<script>
        window.dataLayer = window.dataLayer || [];
        function gtag() { dataLayer.push(arguments); }
        gtag('consent', 'update', { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' });
      </script>`;
    case '/sw':
      return `<script>navigator.serviceWorker.register('/sw.js');</script>`;
    case '/early-srcdoc': {
      const inner = `<script>fetch('${origin}${COLLECT('early')}', { mode: 'no-cors' });</script>`;
      return `<iframe sandbox="allow-scripts" srcdoc="${inner.replaceAll('"', '&quot;')}"></iframe>`;
    }
    case '/unload':
      return `<a href="/next">next</a><script>
        const send = (tag) => {
          navigator.sendBeacon('${origin}${COLLECT('beacon-')}' + tag, 'x');
          fetch('${origin}${COLLECT('keepalive-')}' + tag, { method: 'POST', body: 'x', keepalive: true });
        };
        addEventListener('pagehide', () => send('pagehide'));
        addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send('hidden'); });
      </script>`;
    case '/unload-meta':
      return `<a href="/next">next</a><script>
        addEventListener('pagehide', () => {
          const form = new FormData();
          form.append('id', '100000000000001');
          form.append('ev', 'PageView');
          navigator.sendBeacon('https://www.facebook.com/tr', form);
        });
      </script>`;
    case '/next':
      return '<p>next</p>';
    default:
      return undefined;
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    serverSaw.push(req.url ?? '');
    const html = page(path);
    if (path === '/redirect-to-collect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}${COLLECT('redirected')}` }).end();
      return;
    }
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

test('a collection request from a dedicated worker is stubbed and never reaches the server', async () => {
  const { records } = await visit('/worker-collect', 'stub');
  const requests = collectionRequests({ records } as RunResult).filter((q) => q.url.includes('en=worker'));
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ outcome: 'stubbed' });
  expect(serverSaw.filter((u) => u.includes('en=worker'))).toEqual([]);
  expect(records.flags.filter((f) => f.kind === 'stubBypass')).toEqual([]);
});

// Playwright routes only the first URL of a redirect chain, so the hop reaches the local server and must be flagged.
test('a collection request reached by a redirect is flagged stubBypass in stub mode and not in live mode', async () => {
  const stub = await visit('/redirect', 'stub');
  const hop = collectionRequests(stub).find((q) => q.url.includes('en=redirected'));
  expect(hop).toMatchObject({ initiator: 'redirect', outcome: 'passed' });
  expect(serverSaw.filter((u) => u.includes('en=redirected'))).toHaveLength(1);
  expect(stub.records.flags.filter((f) => f.kind === 'stubBypass').flatMap((f) => f.recordIds)).toContain(hop!.id);
  const live = await visit('/redirect', 'live');
  expect(live.records.flags.filter((f) => f.kind === 'stubBypass')).toEqual([]);
});

test('a GET to the collector origin is kept as an invalid report', async () => {
  const { records } = await visit('/collector-get', 'stub');
  expect(records.invalidReports).toHaveLength(1);
  expect(records.invalidReports[0]).toMatchObject({ error: 'GET request, reports must be POST' });
  expect(records.invalidReports[0]!.body).toContain('/pixel.gif?source=get-pixel');
  expect(records.collectorReports).toEqual([]);
});

test('a consent update from an iframe is recorded but does not start a consent epoch', async () => {
  const { records } = await visit('/frame-consent', 'stub');
  const updates = records.dataLayerEvents.filter((e) => e.isConsentCommand && e.args[1] === 'update');
  expect(updates).toHaveLength(1);
  expect(records.consentEpochs.map((e) => e.label)).not.toContain('granted');
  expect(records.consentEpochs.every((e) => e.state.analytics !== 'granted')).toBe(true);
});

test('service worker requests are recorded without a frame', async () => {
  const { records } = await visit('/sw', 'stub');
  const request = records.requests.find((q) => q.url.endsWith('/from-sw'));
  expect(request).toMatchObject({ frameUrl: null, initiator: 'serviceWorker', outcome: 'passed' });
});

// Chromium sometimes routes this request and sometimes neither routes nor reports it (design §5.3): accept either, but exactly one.
test('a collection request sent while a sandboxed srcdoc iframe loads is either stubbed or the known bypass', async () => {
  const { records } = await visit('/early-srcdoc', 'stub');
  const recorded = collectionRequests({ records } as RunResult).filter((q) => q.url.includes('en=early'));
  const reachedServer = serverSaw.filter((u) => u.includes('en=early'));
  console.info(`early srcdoc request: recorded outcomes ${JSON.stringify(recorded.map((q) => q.outcome))}, reached server ${reachedServer.length}`);
  if (recorded.length > 0) {
    expect(recorded.map((q) => q.outcome)).toEqual(['stubbed']);
    expect(reachedServer).toEqual([]);
  } else {
    expect(reachedServer).toHaveLength(1);
  }
});

test('stub mode answers collection requests sent while the page unloads on same-tab navigation', async () => {
  serverSaw = [];
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: `http://localhost:${port}` });
  try {
    const page = await recorder.visit(`http://localhost:${port}/unload`);
    await page.click('a');
    await page.waitForURL('**/next');
    await recorder.wait(500);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  expect(serverSaw.filter((u) => u.startsWith('/g/collect'))).toEqual([]);
  const sent = collectionRequests({ records } as RunResult);
  expect(sent.length).toBeGreaterThanOrEqual(4);
  expect(sent.every((q) => q.outcome === 'stubbed')).toBe(true);
  for (const tag of ['beacon-pagehide', 'keepalive-pagehide', 'beacon-hidden', 'keepalive-hidden']) {
    expect(sent.some((q) => q.url.includes(`en=${tag}`))).toBe(true);
  }
  expect(records.flags.filter((f) => f.kind === 'stubBypass')).toEqual([]);
});

test('a multipart Meta beacon sent during unload keeps its body and boundary for the decoder', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: `http://localhost:${port}` });
  try {
    const page = await recorder.visit(`http://localhost:${port}/unload-meta`);
    await page.click('a');
    await page.waitForURL('**/next');
    await recorder.wait(500);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const { records } = await recorder.close();
  const sent = records.requests.filter((q) => q.url === 'https://www.facebook.com/tr');
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
  const hits = decodeRequest(sent[0]!);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ vendor: 'meta', event: 'PageView', params: { pixelId: '100000000000001' } });
});
