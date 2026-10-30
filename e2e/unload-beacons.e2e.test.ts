import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type RunRecords } from '../packages/core/src/index.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const scenario = join(root, 'e2e/scenarios/unload-beacons.yml');

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  execFileSync(process.execPath, [join(root, 'scripts/build.ts')], { cwd: root, stdio: 'inherit' });
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'unload-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function run(extra: string[]): Promise<{ records: RunRecords; results: { expectation: string; pass: boolean }[] }> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cli, 'run', scenario, '--site', site.url, '--out', outDir, '--json', ...extra], { cwd: root }, async (_error, stdout) => {
      try {
        const summary = JSON.parse(stdout) as { path: string; results: { expectation: string; pass: boolean }[] };
        resolve({ records: await readRun(summary.path), results: summary.results });
      } catch (error) {
        reject(error);
      }
    });
  });
}

const mustRule = (results: { expectation: string; pass: boolean }[]) => results.find((r) => r.expectation.startsWith('must:'))!;

test('--net-log records the beacon and the keepalive POST a sandboxed frame sends on unload', async () => {
  const { records, results } = await run(['--net-log']);
  const late = records.requests.filter((r) => r.captured === 'netlog');
  expect(late.map((r) => new URL(r.url).searchParams.get('ep.via')).sort()).toEqual(['beacon', 'keepalive']);
  expect(late.every((r) => r.method === 'POST' && r.initiator === 'unload')).toBe(true);
  const hits = records.hits.filter((h) => h.vendor === 'ga4' && h.event === 'add_to_cart');
  expect(hits.map((h) => h.requestId).sort()).toEqual(late.map((r) => r.id).sort());
  expect(hits.every((h) => h.consent.analytics === 'denied')).toBe(true);
  expect(mustRule(results).pass).toBe(true);
  expect(records.flags.filter((f) => f.kind === 'stubBypass')).toHaveLength(2);
  expect(records.flags.some((f) => f.kind === 'unloadGap')).toBe(false);
  expect(await readdir(outDir)).not.toContainEqual(expect.stringMatching(/^netlog-/));
}, 90_000);

test('without --net-log the missing hit is reported as a gap in the summary', async () => {
  const { records, results } = await run([]);
  expect(records.requests.some((r) => r.captured === 'netlog')).toBe(false);
  expect(records.hits.some((h) => h.event === 'add_to_cart')).toBe(false);
  expect(mustRule(results).pass).toBe(false);
  const gap = records.flags.filter((f) => f.kind === 'unloadGap');
  expect(gap).toHaveLength(1);
  expect(gap[0]!.detail).toContain('add_to_cart');
  expect(gap[0]!.detail).toContain('--net-log');
}, 90_000);
