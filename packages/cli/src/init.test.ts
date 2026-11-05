import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { initCommand } from './init.ts';

const exec = promisify(execFile);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'init-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function init(json = false): Promise<string> {
  let out = '';
  expect(await initCommand({ stdout: (t) => (out += t), stderr: () => undefined }, json, dir)).toBe(0);
  return out;
}

const read = (name: string) => readFile(join(dir, name), 'utf8');

test('a fresh directory gets the folders, a starter config and the ignore line, and no scenario', async () => {
  const out = await init();
  expect(out).toBe('Created tagreeve/scenarios/\nCreated tagreeve/baselines/\nCreated tagreeve/config.yml\nCreated .gitignore with /tagreeve/runs/\n');
  expect((await stat(join(dir, 'tagreeve/scenarios'))).isDirectory()).toBe(true);
  expect((await stat(join(dir, 'tagreeve/baselines'))).isDirectory()).toBe(true);
  expect(await read('.gitignore')).toBe('/tagreeve/runs/\n');
  expect(await read('tagreeve/config.yml')).toBe('configSchemaVersion: 1\n# Allowed keys: site, out, options. See docs/cli.md, "Project config".\n# site:\n# out:\n# options:\n');
  expect(await readdir(join(dir, 'tagreeve/scenarios'))).toEqual([]);
});

test('a second run skips everything and adds nothing twice', async () => {
  await init();
  const out = await init();
  expect(out).toBe('Skipped tagreeve/scenarios/: it exists\nSkipped tagreeve/baselines/: it exists\nSkipped tagreeve/config.yml: it exists\nSkipped .gitignore: it already has /tagreeve/runs/\n');
  expect(await read('.gitignore')).toBe('/tagreeve/runs/\n');
});

test('an existing .gitignore is kept and a missing final newline is added', async () => {
  await writeFile(join(dir, '.gitignore'), 'node_modules/');
  expect(await init()).toContain('Added /tagreeve/runs/ to .gitignore');
  expect(await read('.gitignore')).toBe('node_modules/\n/tagreeve/runs/\n');
});

test('existing files in the folders are not touched', async () => {
  await mkdir(join(dir, 'tagreeve/scenarios'), { recursive: true });
  await writeFile(join(dir, 'tagreeve/scenarios/a.yml'), 'start: /\n');
  await init();
  expect(await read('tagreeve/scenarios/a.yml')).toBe('start: /\n');
});

test('a broader runs/ rule that git already applies is not repeated', async () => {
  await exec('git', ['init', '-q', dir]);
  await writeFile(join(dir, '.gitignore'), 'runs/\n');
  const out = await init();
  expect(out).toContain('Skipped .gitignore: git already ignores tagreeve/runs/');
  expect(await read('.gitignore')).toBe('runs/\n');
});

test('an existing config is left byte for byte', async () => {
  await mkdir(join(dir, 'tagreeve'), { recursive: true });
  await writeFile(join(dir, 'tagreeve/config.yml'), 'site: https://shop.example\n');
  expect(await init()).toContain('Skipped tagreeve/config.yml: it exists');
  expect(await read('tagreeve/config.yml')).toBe('site: https://shop.example\n');
});

test('--json prints only the items', async () => {
  const first = await init(true);
  expect(JSON.parse(first)).toEqual({
    items: [
      { path: 'tagreeve/scenarios/', action: 'created' },
      { path: 'tagreeve/baselines/', action: 'created' },
      { path: 'tagreeve/config.yml', action: 'created' },
      { path: '.gitignore', action: 'created' },
    ],
  });
  expect(first.trim().split('\n')).toHaveLength(1);
  const second = JSON.parse(await init(true)) as { items: Array<{ action: string }> };
  expect(second.items.map((i) => i.action)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
});

test('a failed write names the relative path, keeps earlier lines and exits 2', async () => {
  await mkdir(join(dir, '.gitignore'));
  let out = '';
  let err = '';
  const code = await initCommand({ stdout: (t) => (out += t), stderr: (t) => (err += t) }, false, dir);
  expect(code).toBe(2);
  expect(out).toContain('Created tagreeve/config.yml');
  expect(err).toMatch(/^Could not write \.gitignore: /);
  expect(err).not.toContain(dir);
});
