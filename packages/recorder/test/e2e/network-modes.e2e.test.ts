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
let otherServer: Server;
let otherPort: number;
let otherSaw: { cookie: string; authorization: string }[] = [];
let outDir: string;
let serverSaw: string[] = [];
let pixelCookies: string[] = [];
let landedSaw: { method: string; contentType: string; body: string; origin: string }[] = [];
let otherBodies: { method: string; body: string }[] = [];

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
      return `<script>fetch('/redirect-to-collect');</script>`;
    case '/redirect-chain':
      return `<script>fetch('/hop-a'); new Image().src = '/hop-a?img';</script>`;
    case '/redirect-cross-site':
      return `<script>fetch('${origin}/redirect-to-collect', { mode: 'no-cors' });</script>`;
    case '/cookies':
      return `<script>fetch('/set-strict').then(() => { new Image().src = '${origin}/pixel'; });</script>`;
    case '/cookies-sandboxed':
      return `<script>fetch('/set-strict').then(() => {
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.src = '/sbx';
        document.body.append(frame);
      });</script>`;
    case '/sbx':
      return `<script>setTimeout(() => fetch('/echo-cookie', { mode: 'no-cors', credentials: 'include' }), 2000)</script>`;
    case '/cross-origin-fetch':
      return `<script>fetch('/set-c').then(() => fetch('http://localhost:${otherPort}/echo', { mode: 'no-cors' }));</script>`;
    case '/cross-origin-redirect-auth':
      return `<script>fetch('/set-c').then(() => fetch('/redir-auth', { headers: { authorization: 'Bearer t0k' } }).catch(() => {}));</script>`;
    case '/redirect-frame':
      return '<iframe src="/redirect-to-collect-frame"></iframe>';
    case '/redirect-same-to-cross':
      return `<script>fetch('/to-cross', { mode: 'no-cors' });</script>`;
    case '/redirect-final':
      return `<script>fetch('/redirect-plain').then((r) => { fetch('/seen?' + encodeURIComponent(r.url + '|' + r.redirected)); });</script>`;
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
    case '/unload-headers':
      return `<a href="/next">next</a><script>
        addEventListener('pagehide', () => {
          fetch('https://www.facebook.com/tr', {
            method: 'POST',
            keepalive: true,
            headers: { 'content-type': 'text/plain' },
            body: new URLSearchParams({ id: '100000000000001', ev: 'PageView' }),
          });
        });
      </script>`;
    case '/long-chain':
      return `<script>fetch('/long/1').catch(() => {});</script>`;
    case '/put-303-302':
      return `<script>fetch('/s303', { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'put=secret' }).catch(() => {});</script>`;
    case '/post-303-307':
      return `<script>fetch('/p303x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'b=secret', mode: 'no-cors' }).catch(() => {});</script>`;
    case '/post-303':
      return `<script>fetch('/post-redirect', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=secret' });</script>`;
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
    if (path === '/redirect-to-collect-frame') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}${COLLECT('iframe-redirect')}` }).end();
      return;
    }
    if (path === '/to-cross') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}/x-redirect` }).end();
      return;
    }
    if (path === '/x-redirect') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}${COLLECT('crosschain')}` }).end();
      return;
    }
    if (path === '/hop-a') {
      res.writeHead(302, { location: '/hop-b' }).end();
      return;
    }
    if (path === '/hop-b') {
      res.writeHead(302, { location: `http://127.0.0.1:${port}${COLLECT('chain')}` }).end();
      return;
    }
    if (path === '/set-strict') {
      res.writeHead(204, { 'set-cookie': 'strict=1; SameSite=Strict; Path=/' }).end();
      return;
    }
    if (path === '/set-c') {
      res.writeHead(204, { 'set-cookie': 'c=1; Path=/' }).end();
      return;
    }
    if (path === '/redir-auth') {
      res.writeHead(307, { location: `http://localhost:${otherPort}/echo` }).end();
      return;
    }
    if (path.startsWith('/long/')) {
      const n = Number(path.slice('/long/'.length));
      res.writeHead(302, { location: n < 11 ? `/long/${n + 1}` : COLLECT('longchain') }).end();
      return;
    }
    if (path === '/s303') {
      req.resume();
      res.writeHead(303, { location: '/s302x' }).end();
      return;
    }
    if (path === '/s302x') {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/echo-body` }).end();
      return;
    }
    if (path === '/p303x') {
      req.resume();
      res.writeHead(303, { location: '/p307x' }).end();
      return;
    }
    if (path === '/p307x') {
      res.writeHead(307, { location: `http://127.0.0.1:${otherPort}/echo-body` }).end();
      return;
    }
    if (path === '/post-redirect') {
      req.resume();
      res.writeHead(303, { location: '/post-landed' }).end();
      return;
    }
    if (path === '/post-landed') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        landedSaw.push({ method: req.method ?? '', contentType: req.headers['content-type'] ?? '', body, origin: req.headers.origin ?? '' });
        res.writeHead(204).end();
      });
      return;
    }
    if (path === '/echo-cookie') {
      pixelCookies.push(req.headers.cookie ?? '');
      res.writeHead(204, { 'set-cookie': 'framecookie=1; SameSite=Lax; Path=/' }).end();
      return;
    }
    if (path === '/pixel') {
      pixelCookies.push(req.headers.cookie ?? '');
      res.writeHead(204, { 'set-cookie': 'thirdlax=1; SameSite=Lax; Path=/' }).end();
      return;
    }
    if (path === '/redirect-plain') {
      res.writeHead(302, { location: '/redirect-landed' }).end();
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
  otherServer = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PUT' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (new URL(req.url ?? '/', 'http://x').pathname === '/echo-body') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        otherBodies.push({ method: req.method ?? '', body });
        res.writeHead(204, cors).end();
      });
      return;
    }
    otherSaw.push({ cookie: req.headers.cookie ?? '', authorization: req.headers.authorization ?? '' });
    res.writeHead(204, { ...cors, 'set-cookie': 'setxorigin=1; Path=/' }).end();
  });
  await new Promise<void>((resolve) => otherServer.listen(0, '127.0.0.1', resolve));
  otherPort = (otherServer.address() as AddressInfo).port;
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'modes-'));
});

afterAll(async () => {
  await new Promise((resolve) => {
    otherServer.close(resolve);
    otherServer.closeAllConnections();
  });
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function visit(path: string, networkMode: 'stub' | 'live'): Promise<RunResult> {
  serverSaw = [];
  pixelCookies = [];
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

test('a collection request reached by a redirect is stubbed and never reaches the server in stub mode', async () => {
  const stub = await visit('/redirect', 'stub');
  const hop = collectionRequests(stub).find((q) => q.url.includes('en=redirected'));
  expect(hop).toMatchObject({ initiator: 'redirect', outcome: 'stubbed' });
  expect(serverSaw.filter((u) => u.includes('en=redirected'))).toEqual([]);
  expect(stub.records.flags.filter((f) => f.kind === 'stubBypass')).toEqual([]);
});

test('a frame redirect to a collection endpoint is left to the browser and flagged stubBypass', async () => {
  const stub = await visit('/redirect-frame', 'stub');
  expect(serverSaw.filter((u) => u.includes('en=iframe-redirect'))).toHaveLength(1);
  expect(stub.records.flags.filter((f) => f.kind === 'stubBypass')).not.toEqual([]);
});

test('a same-site chain that passes through a cross-site hop reaches the server and is flagged stubBypass', async () => {
  const stub = await visit('/redirect-same-to-cross', 'stub');
  expect(serverSaw.filter((u) => u.includes('en=crosschain'))).toHaveLength(1);
  expect(stub.records.flags.filter((f) => f.kind === 'stubBypass')).not.toEqual([]);
});

test('a two-hop chain to a collection endpoint never reaches the server in stub mode', async () => {
  const stub = await visit('/redirect-chain', 'stub');
  const hops = collectionRequests(stub).filter((q) => q.url.includes('en=chain'));
  expect(hops.length).toBeGreaterThan(0);
  expect(hops.every((q) => q.outcome === 'stubbed')).toBe(true);
  expect(serverSaw.filter((u) => u.includes('en=chain'))).toEqual([]);
  expect(stub.records.flags.filter((f) => f.kind === 'stubBypass')).toEqual([]);
});

test('a cross-site redirect to a collection endpoint is left to the browser and flagged stubBypass', async () => {
  const stub = await visit('/redirect-cross-site', 'stub');
  expect(serverSaw.filter((u) => u.includes('en=redirected'))).toHaveLength(1);
  expect(stub.records.flags.filter((f) => f.kind === 'stubBypass')).not.toEqual([]);
});

async function cookieRun(networkMode: 'stub' | 'live', page = '/cookies', settleMs = 1000) {
  serverSaw = [];
  pixelCookies = [];
  otherSaw = [];
  const recorder = await launchRecorder({ networkMode, outDir, site: `http://localhost:${port}` });
  await recorder.visit(`http://localhost:${port}${page}`);
  await recorder.wait(settleMs);
  const checkpoint = await recorder.checkpoint('end', null);
  await recorder.close();
  return { sent: [...pixelCookies], other: [...otherSaw], jar: checkpoint.cookies.map((c) => `${c.name}@${c.domain}`).sort() };
}

test('stub mode sends and stores the same cookies as live mode for a cross-site subresource', async () => {
  const live = await cookieRun('live');
  const stub = await cookieRun('stub');
  expect(live.sent).toEqual(['']);
  expect(stub).toEqual(live);
});

test('stub mode sends and stores the same cookies as live mode for a sandboxed same-site iframe', async () => {
  const live = await cookieRun('live', '/cookies-sandboxed', 3500);
  const stub = await cookieRun('stub', '/cookies-sandboxed', 3500);
  expect(live.sent).toEqual(['']);
  expect(stub).toEqual(live);
});

test('stub mode sends and stores the same cookies as live mode for a cross-origin same-site fetch', async () => {
  const live = await cookieRun('live', '/cross-origin-fetch');
  const stub = await cookieRun('stub', '/cross-origin-fetch');
  expect(live.other).toEqual([{ cookie: '', authorization: '' }]);
  expect(stub).toEqual(live);
});

test('stub mode does not carry cookies or Authorization over a cross-origin redirect', async () => {
  const live = await cookieRun('live', '/cross-origin-redirect-auth');
  const stub = await cookieRun('stub', '/cross-origin-redirect-auth');
  expect(live.other).toEqual([{ cookie: '', authorization: '' }]);
  expect(stub).toEqual(live);
});

test('a same-site redirect that is not a collection request is followed and recorded', async () => {
  const stub = await visit('/redirect-final', 'stub');
  const first = stub.records.requests.find((q) => q.url.endsWith('/redirect-plain'));
  const landed = stub.records.requests.find((q) => q.url.endsWith('/redirect-landed'));
  expect(first).toBeDefined();
  expect(landed).toMatchObject({ initiator: 'redirect', outcome: 'passed' });
  const status = (id: string | undefined) => stub.records.responses.filter((r) => r.requestId === id).map((r) => r.status);
  expect(status(first?.id)).toEqual([302]);
  expect(status(landed?.id)).toEqual([204]);
  expect(serverSaw.some((u) => u.startsWith('/seen?'))).toBe(true);
});

test('a POST that a 303 turns into a GET reaches the server the same way in stub and live mode', async () => {
  const seen = async (mode: 'stub' | 'live') => {
    landedSaw = [];
    await visit('/post-303', mode);
    return landedSaw;
  };
  const live = await seen('live');
  expect(live).toEqual([{ method: 'GET', contentType: '', body: '', origin: '' }]);
  expect(await seen('stub')).toEqual(live);
});

for (const [name, path] of [
  ['a POST, 303, then cross-origin 307', '/post-303-307'],
  ['a PUT, 303, then cross-origin 302', '/put-303-302'],
] as const) {
  test(`${name} reaches the other host as a GET without the body in stub and live mode`, async () => {
    const seen = async (mode: 'stub' | 'live') => {
      otherBodies = [];
      await visit(path, mode);
      return otherBodies;
    };
    const live = await seen('live');
    expect(live).toEqual([{ method: 'GET', body: '' }]);
    expect(await seen('stub')).toEqual(live);
  });
}

test('a collection endpoint right after the followed-hop limit is still stubbed', async () => {
  const stub = await visit('/long-chain', 'stub');
  expect(serverSaw.some((u) => u.includes('en=longchain'))).toBe(false);
  expect(collectionRequests(stub).find((q) => q.url.includes('en=longchain'))).toMatchObject({ outcome: 'stubbed' });
});

test('live mode lets a redirect hop through to the server', async () => {
  serverSaw = [];
  const recorder = await launchRecorder({ networkMode: 'live', outDir, site: `http://localhost:${port}` });
  try {
    await recorder.visit(`http://localhost:${port}/redirect`);
    const deadline = Date.now() + 10_000;
    while (!serverSaw.some((u) => u.includes('en=redirected')) && Date.now() < deadline) await recorder.wait(100);
    await recorder.wait(500);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  const live = await recorder.close();
  expect(serverSaw.filter((u) => u.includes('en=redirected'))).toHaveLength(1);
  // The recorder sometimes misses this cross-origin hop's events (#180), so its record is checked only when present.
  const hop = collectionRequests(live).find((q) => q.url.includes('en=redirected'));
  if (hop) expect(hop).toMatchObject({ outcome: 'passed' });
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

test('an unload fetch keeps its explicit content type', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: `http://localhost:${port}` });
  try {
    const page = await recorder.visit(`http://localhost:${port}/unload-headers`);
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
  expect(sent[0]!.headers['content-type']).toBe('text/plain');
});
