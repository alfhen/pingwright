import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type Request, type RunRecords } from '../packages/core/src/index.ts';
import { diffRuns } from '../packages/expect/src/index.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const scenario = (name: string) => join(root, 'e2e/scenarios', `${name}.yml`);

let site: FixtureSite;
let outDir: string;
let listFile: string;
let thirdPartyHost: string;

beforeAll(async () => {
  site = await startFixtureSite();
  thirdPartyHost = new URL(site.thirdPartyUrl).host;
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'tracker-'));
  listFile = join(outDir, 'trackers.json');
  await writeFile(
    listFile,
    JSON.stringify([
      { vendor: 'tiktok', host: '127.0.0.1', source: 'https://example.com/tiktok-pixel-docs' },
      { vendor: 'criteo', host: 'criteo.localhost', paths: ['/m/collect'], source: 'https://example.com/criteo-docs' },
    ]),
  );
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stderr: string;
  records: RunRecords | undefined;
  failed: string[];
}

function runCli(scenarioPath: string, extra: string[]): Promise<CliRun> {
  const args = ['run', scenarioPath, '--site', site.url, '--out', outDir, '--json', ...extra];
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root }, async (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      let records: RunRecords | undefined;
      let failed: string[] = [];
      try {
        const summary = JSON.parse(stdout) as { path: string; results: { expectation: string; pass: boolean }[] };
        records = await readRun(summary.path);
        failed = summary.results.filter((r) => !r.pass).map((r) => r.expectation);
      } catch {
        // Not a JSON summary: a usage or run error.
      }
      resolve({ code, stderr, records, failed });
    });
  });
}

const withList = (name: string) => runCli(scenario(name), ['--tracker-list', listFile]);
const find = (records: RunRecords, predicate: (r: Request) => boolean) => records.requests.filter(predicate);
const isTiktokPixel = (r: Request) => r.url.startsWith(`${site.thirdPartyUrl}/api/v2/pixel`);
const isTiktokScript = (r: Request) => r.url === `${site.thirdPartyUrl}/i18n/pixel/events.js`;
const isCriteoCollect = (r: Request) => r.url.startsWith('http://criteo.localhost:') && r.url.includes('/m/collect');

test('listed trackers are stubbed, decoded to hits and not flagged, and the pixel script load passes', async () => {
  const r = await withList('tracker');
  expect(r.code).toBe(0);
  const { requests, hits, flags } = r.records!;

  const pixel = find(r.records!, isTiktokPixel);
  expect(pixel.length).toBe(1);
  expect(pixel[0]!.outcome).toBe('stubbed');
  expect(find(r.records!, isTiktokScript).map((q) => q.outcome)).toEqual(['passed']);

  const jsonp = find(r.records!, isCriteoCollect);
  expect(jsonp.length).toBe(1);
  expect(jsonp[0]!.resourceType).toBe('script');
  expect(jsonp[0]!.outcome).toBe('stubbed');

  const tiktok = hits.filter((h) => h.vendor === 'tiktok');
  expect(tiktok.map((h) => [h.event, h.transport, h.requestId])).toEqual([['Purchase', 'tracker-list', pixel[0]!.id]]);
  expect(tiktok[0]!.page).toBe(`${site.url}/tracker`);
  expect(hits.filter((h) => h.vendor === 'criteo').map((h) => h.event)).toEqual(['viewItem']);
  expect(new Set(hits.map((h) => h.requestId)).size).toBe(hits.length);
  expect(flags.filter((f) => f.kind === 'unknownDestination' || f.kind === 'stubBypass')).toEqual([]);
  expect(requests.some((q) => q.outcome === 'stubbed')).toBe(true);
}, 90_000);

test('a vendor rule and a host rule both match a listed tracker before consent', async () => {
  const path = join(outDir, 'tracker-host.yml');
  await writeFile(
    path,
    [
      'start: /tracker',
      'steps:',
      '  - wait: 3s',
      'expect:',
      '  mustNot:',
      '    - { vendor: tiktok, before: consent }',
      `    - { host: "${thirdPartyHost}", before: consent }`,
      'options: { seed: 1 }',
      '',
    ].join('\n'),
  );
  const r = await runCli(path, ['--tracker-list', listFile]);
  expect(r.code).toBe(1);
  expect(r.failed.filter((f) => f.startsWith('mustNot:'))).toHaveLength(2);
  const pixel = find(r.records!, isTiktokPixel)[0]!;
  const mustNot = r.records!.results.filter((x) => x.expectation.startsWith('mustNot:'));
  for (const result of mustNot) expect(result.evidence.length).toBeGreaterThan(0);
  const hit = r.records!.hits.find((h) => h.requestId === pixel.id)!;
  expect(mustNot.every((x) => x.evidence.includes(hit.id))).toBe(true);
}, 90_000);

test('a scenario that names a listed vendor fails to parse without the list', async () => {
  const r = await runCli(scenario('tracker'), []);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('tiktok');
}, 30_000);

test('a bad tracker list exits 2', async () => {
  const path = join(outDir, 'bad.json');
  await writeFile(path, JSON.stringify([{ vendor: 'Bad Vendor', host: 'x.example.com', source: 'https://example.com' }]));
  const r = await runCli(scenario('tracker-plain'), ['--tracker-list', path]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('vendor');
}, 30_000);

test('diff shows the tracker hits that only the run with the list has', async () => {
  const a = await withList('tracker-plain');
  const b = await runCli(scenario('tracker-plain'), []);
  expect(find(b.records!, isTiktokPixel).map((q) => q.outcome)).toEqual(['passed']);
  expect(b.records!.hits.filter((h) => h.vendor === 'tiktok')).toEqual([]);
  const diff = diffRuns(a.records!, b.records!);
  const removed = diff.removed.map((x) => `${x.key.vendor}/${x.key.event}`).sort();
  expect(removed).toEqual(['criteo/viewItem', 'tiktok/Purchase']);
  expect(diff.added).toEqual([]);
}, 120_000);
