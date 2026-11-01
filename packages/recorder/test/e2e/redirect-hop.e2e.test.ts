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

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (path.startsWith('/g/collect')) serverSaw.push(path);
    if (path === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('<iframe src="/child"></iframe>');
    else if (path === '/child') res.writeHead(200, { 'content-type': 'text/html' }).end(`<script>fetch('/r');</script>`);
    else if (path === '/r') res.writeHead(302, { location: `http://127.0.0.1:${port}/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=hop` }).end();
    else res.writeHead(204).end();
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
// The first request then fails with no response and no redirectedTo(), so the recorder has nothing to walk.
// What must hold in every run: the hop is flagged, or the first request is recorded as failed with no response.
test(`a missed redirect hop leaves the failed first request as its only trace, in ${RUNS} runs`, { timeout: RUNS * 10_000 }, async () => {
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
    const answered = first !== undefined && records.responses.some((r) => r.requestId === first.id);
    if (hops.length > 0 || first?.outcome !== 'failed' || answered) unexplained.push(run);
  }
  expect(unexplained).toEqual([]);
});
