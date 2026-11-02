import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');

let site: FixtureSite;
let outDir: string;

function node(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'report-out-folder-'));
}, 60_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('report reads the --out folder of a suite run', async () => {
  const out = join(outDir, 'runs');
  const suite = await node(['suite', join(root, 'e2e/suites/cells'), '--site', site.url, '--out', out]);
  expect(suite.code, suite.stderr).toBe(1);
  const page = join(outDir, 'out-folder.html');
  const report = await node(['report', out, '--html', page]);
  expect(report.code, report.stderr).toBe(0);
  expect(report.stderr).toContain('suite_');
  expect(await readFile(page, 'utf8')).toContain('Tagreeve suite:');
}, 300_000);
