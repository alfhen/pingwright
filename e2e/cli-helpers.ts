import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type Hit, type RunRecords } from '../packages/core/src/index.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll } from 'vitest';

export const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
export const rootVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
export const scenario = (name: string) => join(root, 'e2e/scenarios', `${name}.yml`);

export let site: FixtureSite;
export let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'cli-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  records: RunRecords | undefined;
  failed: string[];
}

export function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env } }, async (error, stdout, stderr) => {
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
      resolve({ code, stdout, stderr, records, failed });
    });
  });
}

export const run = (name: string, extra: string[] = [], env: Record<string, string> = {}) =>
  runCli(['run', scenario(name), '--site', site.url, '--out', outDir, '--json', ...extra], env);

export const ga4 = (hits: Hit[], event: string) => hits.filter((h) => h.vendor === 'ga4' && h.event === event);

// The fixture's sandboxed pixel sends its sandbox URL as the page, so this built-in check fails on every run of a page that has the pixel.
export const SANDBOX = 'builtin: sandboxPageUrl';

export const UNKNOWN = 'builtin: unknownDestination';
