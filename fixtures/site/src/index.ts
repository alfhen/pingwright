import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolveContainer } from './containers.ts';

export interface FixtureSite {
  url: string;
  sgtmUrl: string;
  thirdPartyUrl: string;
  containerUrl: string;
  receivedGtmAuth: string[];
  close(): Promise<void>;
}

const publicDir = new URL('../public/', import.meta.url);

const pages: Record<string, string> = {
  '/': 'index.html',
  '/products/fake-tee': 'product.html',
  '/collections/all': 'collection.html',
  '/cart': 'cart.html',
  '/checkout': 'checkout.html',
  '/checkout/payment': 'payment.html',
  '/thank-you': 'thank-you.html',
  '/pinterest': 'pinterest.html',
  '/tracker': 'tracker.html',
  '/unload-beacons': 'unload-beacons.html',
  '/unload-beacons-bare': 'unload-beacons-bare.html',
  '/unload-gap': 'unload-gap.html',
  '/unload-request-body': 'unload-request-body.html',
  '/stable-ids': 'stable-ids.html',
  '/shared-hashes': 'shared-hashes.html',
  '/sgtm-data-tag': 'sgtm-data-tag.html',
  '/meta-purchase-no-hash': 'meta-purchase-no-hash.html',
  '/delayed-hit': 'delayed-hit.html',
  '/sgtm-leak': 'sgtm-leak.html',
  '/identifiers': 'identifiers.html',
  '/cookies': 'cookies.html',
  '/tiles': 'tiles.html',
  '/select': 'select.html',
  '/handoff': 'handoff.html',
  '/handoff/second': 'handoff-second.html',
  '/handoff-patched': 'handoff-patched.html',
  '/set-cookie-unstored': 'set-cookie-unstored.html',
  '/set-cookie-already': 'set-cookie-already.html',
  '/meta-early': 'meta-early.html',
  '/container/direct': 'container-direct.html',
  '/container/echo': 'container-echo.html',
  '/container/echo-frame': 'container-echo-frame.html',
  '/container/noversion': 'container-noversion.html',
  '/container/stape': 'container-stape.html',
  '/container/sandbox': 'container-sandbox.html',
  '/container/stape-script': 'container-stape-script.html',
  '/container/sandbox-script': 'container-sandbox-script.html',
  '/container/redirect-script': 'container-redirect-script.html',
};

const containerPixelPath = '/web-pixels@0.0.0-fixture/sandbox/container/';
const unloadPixelPath = '/web-pixels@0.0.0-fixture/sandbox/unload/';
const gapPixelPath = '/web-pixels@0.0.0-fixture/sandbox/gap/';
const containerScriptPixelPath = '/web-pixels@0.0.0-fixture/sandbox/container-script/';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function sendFile(res: ServerResponse, file: string): Promise<void> {
  const ext = file.slice(file.lastIndexOf('.'));
  try {
    const body = await readFile(new URL(file, publicDir));
    res.writeHead(200, { 'content-type': contentTypes[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

function shopHandler(config: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const page = pages[path];
    if (path === '/fixture-config.js') {
      res.writeHead(200, { 'content-type': contentTypes['.js']!, 'cache-control': 'no-store' });
      res.end(config);
    } else if (path === '/session/start') {
      res.writeHead(204, { 'set-cookie': '_pwid=pwfake-0001; Path=/; Max-Age=3600; SameSite=Lax', 'cache-control': 'no-store' }).end();
    } else if (path === '/session/unstored') {
      res.writeHead(204, { 'set-cookie': '_pwunstored=pw-fixture-cookie-value; Domain=other.example; Path=/; Max-Age=3600', 'cache-control': 'no-store' }).end();
    } else if (path === '/session/already') {
      res.writeHead(204, { 'set-cookie': '_pwalready=pw-fixture-cookie-value; Domain=other.example; Path=/; Max-Age=3600', 'cache-control': 'no-store' }).end();
    } else if (/^\/web-pixels@[\w.-]+\/sandbox\/modern\/$/.test(path)) {
      await sendFile(res, 'pixel.html');
    } else if (path === containerPixelPath) {
      await sendFile(res, 'container-frame.html');
    } else if (path === unloadPixelPath) {
      await sendFile(res, 'unload-pixel.html');
    } else if (path === gapPixelPath) {
      await sendFile(res, 'gap-pixel.html');
    } else if (path === containerScriptPixelPath) {
      await sendFile(res, 'container-frame-script.html');
    } else if (page) {
      await sendFile(res, page);
    } else if (/^\/assets\/app-[0-9a-f]{64}\.js$/.test(path)) {
      await sendFile(res, 'assets/hashed-app.js');
    } else if (/^\/assets\/[a-z-]+\.(js|css)$/.test(path)) {
      await sendFile(res, path.slice(1));
    } else {
      res.writeHead(404).end('not found');
    }
  };
}

function decodeBase64(value: string | null): string {
  return value ? Buffer.from(value, 'base64').toString('utf8') : '';
}

function sendContainer(res: ServerResponse, params: URLSearchParams, thirdPartyUrl: string, received: string[]): void {
  const auth = params.get('gtm_auth');
  if (auth !== null) received.push(auth);
  const result = resolveContainer(params, thirdPartyUrl);
  if (result.status === 404) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': contentTypes['.js']!, 'cache-control': 'no-store' });
  res.end(result.body);
}

function containerHandler(thirdPartyUrl: string, received: string[]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/gtm.js') sendContainer(res, url.searchParams, thirdPartyUrl, received);
    else res.writeHead(404).end('not found');
  };
}

// The Stape-style loader script URL hides the path with a fixed transform that is not base64: the reversed string.
function deobfuscate(value: string | null): string {
  return value === null ? '' : [...value].reverse().join('');
}

function sgtmHandler(thirdPartyUrl: string, received: string[]) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/pwcookie') {
      res.writeHead(204, { 'set-cookie': '_pwdcid=pwfake-client.0001; Path=/; Max-Age=3600' }).end();
      return;
    }
    const real = url.pathname === '/pwstape' ? decodeBase64(url.searchParams.get('pk')) : '';
    const scriptReal = /^\/[a-z0-9-]+\.js$/.test(url.pathname) ? deobfuscate(url.searchParams.get('k')) : '';
    if (/^\/pwredir-[a-z0-9]+\.js$/.test(url.pathname)) {
      res.writeHead(302, { location: '/g/collect?v=2&tid=G-PWTEST0001&cid=5555555555.6666666666&en=redirect_hit' }).end();
    } else if (scriptReal.startsWith('/gtm.js')) {
      sendContainer(res, new URL(scriptReal, 'http://127.0.0.1').searchParams, thirdPartyUrl, received);
    } else if (real.startsWith('/gtm.js')) {
      sendContainer(res, new URL(real, 'http://127.0.0.1').searchParams, thirdPartyUrl, received);
    } else if (real.startsWith('/gtag/js')) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end('/* fixture sgtm gtag.js */');
    } else {
      res.writeHead(204).end();
    }
  };
}

function thirdPartyHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'image/gif' });
  res.end(gif);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const received: string[] = [];
  const thirdParty = createServer(thirdPartyHandler);
  const thirdPartyUrl = `http://127.0.0.1:${await listen(thirdParty)}`;
  const sgtm = createServer(sgtmHandler(thirdPartyUrl, received));
  const sgtmUrl = `http://127.0.0.1:${await listen(sgtm)}`;
  const container = createServer(containerHandler(thirdPartyUrl, received));
  const containerUrl = `http://127.0.0.1:${await listen(container)}`;
  const config = `window.__PW_FIXTURE=${JSON.stringify({ sgtmUrl, thirdPartyUrl })};`;
  const handler = shopHandler(config);
  const shop = createServer((req, res) => void handler(req, res));
  const url = `http://localhost:${await listen(shop)}`;
  return {
    url,
    sgtmUrl,
    thirdPartyUrl,
    containerUrl,
    receivedGtmAuth: received,
    close: async () => {
      await Promise.all([shop, sgtm, thirdParty, container].map(closeServer));
    },
  };
}
