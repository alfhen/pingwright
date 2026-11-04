import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, scenario, site } from './cli-helpers.ts';

const cli = join(root, 'dist/cli.js');

function runIn(cwd: string, extra: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, 'run', scenario('from-label'), '--site', site.url, '--json', ...extra], { cwd }, (_error, stdout, stderr) => resolve({ stdout, stderr }));
  });
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const NOTICE = 'holds older records';

test('without --out the record goes to tagreeve/runs/<date>/, and --out x writes x/', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const before = today();
  const first = await runIn(cwd, []);
  const after = today();
  const path = (JSON.parse(first.stdout) as { path: string }).path;
  const dates = new Set([before, after]);
  const folder = [...dates].map((d) => join('tagreeve', 'runs', d));
  expect(folder.some((f) => path.startsWith(f) || path.includes(f))).toBe(true);
  const date = [...dates].find((d) => path.includes(d))!;
  expect((await readdir(join(cwd, 'tagreeve', 'runs', date))).some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
  expect(first.stderr).not.toContain(NOTICE);

  const second = await runIn(cwd, ['--out', 'x']);
  expect((await readdir(join(cwd, 'x'))).some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
  expect(second.stderr).not.toContain(NOTICE);
  await rm(cwd, { recursive: true, force: true });
}, 120_000);

test('old records in ./runs/ give the notice once, and --out runs gives none', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  await mkdir(join(cwd, 'runs'));
  await writeFile(join(cwd, 'runs', 'run_old.jsonl'), '');
  const noisy = await runIn(cwd, []);
  expect(noisy.stderr.split(NOTICE).length - 1).toBe(1);
  const quiet = await runIn(cwd, ['--out', 'runs']);
  expect(quiet.stderr).not.toContain(NOTICE);
  await rm(cwd, { recursive: true, force: true });
}, 120_000);
