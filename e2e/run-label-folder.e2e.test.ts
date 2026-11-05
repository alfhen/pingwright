import { execFile } from 'node:child_process';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, scenario, site } from './cli-helpers.ts';

const cli = join(root, 'dist/cli.js');

function runIn(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const failure = (r: { stdout: string; stderr: string }) => {
  let failed: unknown[] = [];
  try {
    failed = (JSON.parse(r.stdout) as { results: { pass: boolean }[] }).results.filter((x) => !x.pass);
  } catch {
    // Not a JSON summary.
  }
  return `${r.stderr}\nfailed results: ${JSON.stringify(failed)}\nstdout: ${r.stdout.slice(0, 2000)}`;
};

const runArgs = (...extra: string[]) => ['run', scenario('run-label'), '--site', site.url, ...extra];

test('--label with --out exits 0 and writes to the folder as given', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const r = await runIn(cwd, runArgs('--json', '--label', 'x', '--out', 'o'));
  expect(r.code, failure(r)).toBe(0);
  expect((JSON.parse(r.stdout) as { label: string }).label).toBe('x');
  expect((await readdir(join(cwd, 'o'))).some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
}, 120_000);

test('a run without a label exits 0, prints the record and no Label line, and has no label key in --json', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const json = await runIn(cwd, runArgs('--out', 'o', '--json'));
  expect(json.code, failure(json)).toBe(0);
  expect(json.stdout).toContain('"path"');
  expect(JSON.parse(json.stdout)).not.toHaveProperty('label');
  const text = await runIn(cwd, runArgs('--out', 'o'));
  expect(text.code, failure(text)).toBe(0);
  expect(text.stdout).toContain('Record:');
  expect(text.stdout).not.toContain('Label:');
}, 120_000);

test('a bad label exits 2 and creates no tagreeve folder', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const r = await runIn(cwd, runArgs('--label', 'Bad_Label'));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('--label must be 1 to 40 lowercase letters, digits or hyphens, got "Bad_Label"');
  await expect(stat(join(cwd, 'tagreeve'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a suite with no site exits 2 and prints the suite help hint', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const r = await runIn(cwd, ['suite', join(root, 'e2e/suites/stores')]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('suite needs a site');
  expect(r.stderr).toContain('Run tagreeve suite --help for the options.');
  await expect(stat(join(cwd, 'tagreeve'))).rejects.toMatchObject({ code: 'ENOENT' });
});
