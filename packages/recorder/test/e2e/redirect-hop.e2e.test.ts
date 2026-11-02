import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { recordVisit } from '../../src/index.ts';

const RUNS = 30;

let server: Server;
let port: number;
let outDir: string;
let serverSaw: string[] = [];
let hopAllowsCors = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/g/collect')) serverSaw.push(path);
    if (path === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('<iframe src="/child"></iframe>');
    else if (path === '/child') res.writeHead(200, { 'content-type': 'text/html' }).end(`<script>fetch('/r');</script>`);
    else if (path === '/r') res.writeHead(302, { location: `http://127.0.0.1:${port}/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=hop` }).end();
    else res.writeHead(204, hopAllowsCors ? { 'access-control-allow-origin': '*' } : {}).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'redirect-hop-'));
});

afterAll(async () => {
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  });
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

// Playwright sometimes reports neither the redirect nor the hop that Chromium follows from a child frame (#180).
// The first request then fails with ERR_FAILED, or, when the hop allows CORS, carries the hop's response. What must hold in every run where the server saw the hop:
// the hop is flagged stubBypass, or the first request carries possibleRedirectHop.
test.each([false, true])(`every redirect hop the server saw is flagged, or its first request is flagged possibleRedirectHop, in ${RUNS} runs (hop sends CORS headers: %s)`, { timeout: RUNS * 10_000 }, async (cors) => {
  hopAllowsCors = cors;
  const unexplained: number[] = [];
  for (let run = 0; run < RUNS; run++) {
    serverSaw = [];
    const { records } = await recordVisit({
      networkMode: 'stub',
      outDir,
      site: `http://localhost:${port}`,
      startUrl: `http://localhost:${port}/`,
      waitMs: 500,
    });
    if (serverSaw.length === 0) continue;
    const hops = records.requests.filter((q) => q.url.includes('en=hop'));
    if (hops.some((h) => records.flags.some((f) => f.kind === 'stubBypass' && f.recordIds.includes(h.id)))) continue;
    const first = records.requests.find((q) => q.url === `http://localhost:${port}/r`);
    const flagged = first !== undefined && records.flags.some((f) => f.kind === 'possibleRedirectHop' && f.recordIds.includes(first.id));
    if (!flagged) unexplained.push(run);
  }
  expect(unexplained).toEqual([]);
});
