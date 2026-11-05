import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { outDir, root, site } from './cli-helpers.ts';

const exec = promisify(execFile);
const cli = join(root, 'dist/cli.js');
const suiteDir = join(root, 'e2e/suites/clean');

async function suiteIn(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, 'suite', suiteDir, '--site', site.url, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

const warnings = (stderr: string): string[] => stderr.split('\n').filter((line) => line.startsWith('Warning:'));

test('suite --out warns once for a folder git would commit, and not when a rule ignores the records', async () => {
  const cwd = await mkdtemp(join(outDir, 'ignore-'));
  try {
    await exec('git', ['init', '-q', cwd]);

    const first = await suiteIn(cwd, ['--out', 'records']);
    expect(first.code, first.stderr).toBe(0);
    await expect(readdir(join(cwd, 'records'))).resolves.not.toHaveLength(0);
    expect(warnings(first.stderr)).toEqual([expect.stringContaining('records is not in .gitignore')]);

    await writeFile(join(cwd, '.gitignore'), 'records/**\n');
    const ignored = await suiteIn(cwd, ['--out', 'records']);
    expect(ignored.code, ignored.stderr).toBe(0);
    expect(warnings(ignored.stderr)).toEqual([]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 180_000);
