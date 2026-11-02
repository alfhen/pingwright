import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readVersion } from './version.ts';

const path = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const dependencies = Object.keys((JSON.parse(readFileSync(path('package.json'), 'utf8')) as { dependencies: object }).dependencies);
let dir: string;
let bundle: string;

beforeAll(async () => {
  dir = mkdtempSync(join(path(''), '.alias-test-'));
  bundle = join(dir, 'alias.mjs');
  await build({
    entryPoints: [path('packages/cli/src/alias-bin.ts')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: Object.fromEntries(readdirSync(path('packages')).map((name) => [`@tagreeve/${name}`, path(`packages/${name}/src/index.ts`)])),
    external: dependencies,
    logLevel: 'silent',
  });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) => spawnSync(process.execPath, [bundle, ...args], { encoding: 'utf8', cwd: path('') });

test('the alias prints the notice on stderr and passes the arguments on', () => {
  const result = run('--version');
  expect(result.stderr).toBe('pingwright is now tagreeve; this alias goes in 0.5.0\n');
  expect(result.stdout.trim()).toBe(readVersion());
  expect(result.status).toBe(0);
});

test('the alias keeps stdout clean and the exit code of the CLI', () => {
  const result = run('run');
  expect(result.stderr.startsWith('pingwright is now tagreeve;')).toBe(true);
  expect(result.stdout).not.toContain('pingwright is now');
  expect(result.status).not.toBe(0);
});
