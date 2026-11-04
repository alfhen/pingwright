import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { recordVisit } from '../../src/index.ts';

let server: Server;
let port: number;
let outDir: string;

const top = `<script>setTimeout(function () { fetch('/r'); }, 600);</script><iframe id="f" src="/"></iframe>`;
const child = `<script>window.dataLayer = window.dataLayer || []; setTimeout(function () { window.dataLayer.push({ event: 'add_to_cart' }); }, 200);</script>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path === '/') {
      const html = req.headers['sec-fetch-dest'] === 'iframe' ? child : top;
      res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    } else if (path === '/r') {
      res.writeHead(302, { location: `http://localhost:${port}/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&gcs=G100&en=other_frame_ga` }).end();
    } else res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  outDir = await mkdtemp(join(tmpdir(), 'pw-redirect-frame-id-'));
});

afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('a redirected hit from the top frame does not cover a push from an embedded frame with the same URL', async () => {
  const { records } = await recordVisit({ networkMode: 'stub', outDir, site: `http://localhost:${port}`, startUrl: `http://localhost:${port}/`, waitMs: 1500 });
  const hop = records.requests.find((q) => q.initiator === 'redirect' && q.url.includes('en=other_frame_ga'));
  expect(hop).toBeDefined();
  expect(hop!.frameUrl).toBe(`http://localhost:${port}/`);
  const push = records.dataLayerEvents.find((e) => e.event === 'add_to_cart');
  expect(push).toBeDefined();
  const hit = records.hits.find((h) => h.requestId === hop!.id);
  expect(hit?.vendor).toBe('ga4');
  expect(hit!.t).toBeGreaterThanOrEqual(push!.t);
  const gaps = records.flags.filter((f) => f.kind === 'unloadGap');
  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.recordIds).toEqual([push!.id]);
}, 60_000);
