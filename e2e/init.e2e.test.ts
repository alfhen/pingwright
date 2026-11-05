import { execFile } from 'node:child_process';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { root, scenario, site } from './cli-helpers.ts';

const cli = join(root, 'dist/cli.js');
const WARNING = 'is not in .gitignore';

function tagreeve(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ stdout, stderr, code: error ? (typeof code === 'number' ? code : 1) : 0 });
    });
  });
}

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function gitExit(cwd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (error) => resolve(error ? ((error as { code?: unknown }).code as number) || 1 : 0));
  });
}

const runArgs = (extra: string[]) => ['run', scenario('from-label'), '--site', site.url, '--json', ...extra];

test('in a git work tree, init stops the warning, and --out records warns once', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tagreeve-init-'));
  await new Promise<void>((resolve, reject) => execFile('git', ['init', '-q', cwd], (error) => (error ? reject(error) : resolve())));

  const init = await tagreeve(cwd, ['init']);
  expect(init.code).toBe(0);
  expect(init.stdout).toContain('Created tagreeve/scenarios/');
  expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('/tagreeve/runs/\n');
  expect((await tagreeve(cwd, ['init'])).stdout).toContain('Skipped .gitignore');
  expect(await readFile(join(cwd, '.gitignore'), 'utf8')).toBe('/tagreeve/runs/\n');

  const before = today();
  const quiet = await tagreeve(cwd, runArgs([]));
  const after = today();
  expect(quiet.code, quiet.stderr).toBeLessThanOrEqual(1);
  const recorded = (JSON.parse(quiet.stdout) as { path: string }).path;
  const date = [before, after].find((d) => recorded.includes(join('tagreeve', 'runs', d)));
  expect(date, recorded).toBeDefined();
  expect((await readdir(join(cwd, 'tagreeve', 'runs', date!))).some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
  expect(await gitExit(cwd, ['check-ignore', '-q', recorded])).toBe(0);
  expect(quiet.stderr).not.toContain(WARNING);

  const loud = await tagreeve(cwd, runArgs(['--out', 'records']));
  expect(loud.stderr.split(WARNING).length - 1).toBe(1);
  expect(loud.stderr).toContain('Warning: records is not in .gitignore');
  expect((await readdir(join(cwd, 'records'))).some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
  await rm(cwd, { recursive: true, force: true });
}, 180_000);

test('outside a git work tree there is no warning', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tagreeve-init-'));
  expect(await gitExit(cwd, ['rev-parse', '--is-inside-work-tree'])).not.toBe(0);
  const outside = await tagreeve(cwd, runArgs(['--out', 'records']));
  expect(outside.code, outside.stderr).toBeLessThanOrEqual(1);
  expect(outside.stderr).not.toContain(WARNING);
  expect((await readdir(join(cwd, 'records'))).some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
  await rm(cwd, { recursive: true, force: true });
}, 120_000);

test('init writes a starter config that a run reads, and --json prints items', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'tagreeve-init-'));
  const init = await tagreeve(cwd, ['init']);
  expect(init.code, init.stderr).toBe(0);
  expect(init.stdout).toContain('Created tagreeve/config.yml');
  expect(await readFile(join(cwd, 'tagreeve/config.yml'), 'utf8')).toMatch(/^configSchemaVersion: 1\n/);

  const run = await tagreeve(cwd, ['run', scenario('from-label'), '--site', site.url, '--out', 'records']);
  expect(run.code, run.stderr).toBeLessThanOrEqual(1);
  expect(run.stdout).toMatch(/Defaults: .*tagreeve\/config\.yml/);

  const again = await tagreeve(cwd, ['init', '--json']);
  expect(again.code, again.stderr).toBe(0);
  const parsed = JSON.parse(again.stdout) as { items: Array<{ path: string; action: string }> };
  expect(parsed.items).toContainEqual({ path: 'tagreeve/config.yml', action: 'skipped' });

  const bogus = await tagreeve(cwd, ['init', '--bogus']);
  expect(bogus.code).toBe(2);
  await rm(cwd, { recursive: true, force: true });
}, 180_000);
