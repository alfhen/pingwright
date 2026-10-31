import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchRecorder } from './index.ts';

let site: Server;
let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'pw-server-mode-'));
  site = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><title>t</title><script>` +
          `fetch('/g/collect?v=2&tid=G-PWTEST0001&en=page_view');` +
          `fetch('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&en=page_view',{method:'POST'});` +
          `</script>`,
      );
      return;
    }
    res.end('ok');
  });
});

afterAll(async () => {
  site?.close();
  await rm(outDir, { recursive: true, force: true });
});

test('server mode passes a collection request to a serverHost and stubs the same request to any other host', async () => {
  const port = await new Promise<number>((resolve) => site.listen(0, '127.0.0.1', () => resolve((site.address() as AddressInfo).port)));
  const recorder = await launchRecorder({
    networkMode: 'server',
    serverHosts: ['127.0.0.1'],
    outDir,
    site: `http://127.0.0.1:${port}`,
  });
  await recorder.visit(`http://127.0.0.1:${port}/`);
  await recorder.wait(500);
  const { requests } = (await recorder.close()).records;
  const outcome = (host: string) => requests.find((r) => new URL(r.url).hostname === host && r.url.includes('/g/collect'))?.outcome;
  expect(outcome('127.0.0.1')).toBe('passed');
  expect(outcome('www.google-analytics.com')).toBe('stubbed');
});
