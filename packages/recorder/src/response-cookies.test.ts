import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { launchRecorder } from './index.ts';

let site: Server;
let third: Server;
let outDir: string;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'pw-response-cookies-'));
  third = createServer((_req, res) => {
    res.setHeader('set-cookie', ['_pwthird=1; Path=/', '_pwthird2=1; Path=/']);
    res.setHeader('content-type', 'image/gif');
    res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
  });
  const thirdPort = await listen(third);
  site = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('set-cookie', '_pwfirst=1; Path=/');
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><title>t</title><img src="http://127.0.0.1:${thirdPort}/p.gif">` +
          `<script>fetch('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&en=page_view',{method:'POST'});` +
          `fetch('/g/collect?v=2&tid=G-PWTEST0001&en=page_view')</script>`,
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
});

afterAll(async () => {
  site?.close();
  third?.close();
  await rm(outDir, { recursive: true, force: true });
});

test('a passed response records its Set-Cookie names on first and third party hosts, a stubbed one records none', async () => {
  const port = await listen(site);
  const recorder = await launchRecorder({
    networkMode: 'stub',
    outDir,
    site: `http://localhost:${port}`,
  });
  await recorder.visit(`http://localhost:${port}/`);
  await recorder.wait(500);
  await recorder.checkpoint('end', null);
  const result = await recorder.close();
  const { requests, responses } = result.records;
  const namesFor = (match: (url: string) => boolean): string[][] =>
    requests.filter((r) => match(r.url)).map((r) => responses.find((x) => x.requestId === r.id)?.setCookieNames ?? ['<none>']);

  expect(namesFor((u) => u === `http://localhost:${port}/`)).toEqual([['_pwfirst']]);
  expect(namesFor((u) => u.includes('/p.gif'))).toEqual([['_pwthird', '_pwthird2']]);
  const stubbed = requests.filter((r) => r.outcome === 'stubbed');
  expect(stubbed.length).toBeGreaterThan(0);
  for (const r of stubbed) expect(responses.find((x) => x.requestId === r.id)?.setCookieNames).toEqual([]);
  expect(requests.some((r) => r.outcome === 'stubbed' && new URL(r.url).host === `localhost:${port}`)).toBe(true);
  const jarNames = new Set(result.records.checkpoints.flatMap((c) => c.cookies.map((x) => x.name)));
  expect(jarNames.size).toBeGreaterThan(0);
  expect([...jarNames].filter((n) => n !== '_pwfirst' && n !== '_pwthird' && n !== '_pwthird2')).toEqual([]);
  expect(JSON.stringify(result.records)).not.toContain('_pwfirst=1');
});
