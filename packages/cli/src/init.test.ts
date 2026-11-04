import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

async function init(): Promise<string> {
  let out = '';
  expect(await initCommand({ stdout: (t) => (out += t), stderr: () => undefined }, dir)).toBe(0);
  return out;
}

const read = (name: string) => readFile(join(dir, name), 'utf8');

test('a fresh directory gets the folders and the ignore line, and no scenario or config', async () => {
  const out = await init();
  expect(out).toBe('Created tagreeve/scenarios/\nCreated tagreeve/baselines/\nCreated .gitignore with /tagreeve/runs/\n');
  expect((await stat(join(dir, 'tagreeve/scenarios'))).isDirectory()).toBe(true);
  expect((await stat(join(dir, 'tagreeve/baselines'))).isDirectory()).toBe(true);
  expect(await read('.gitignore')).toBe('/tagreeve/runs/\n');
  await expect(stat(join(dir, 'tagreeve/config.yml'))).rejects.toThrow();
});

test('a second run skips everything and adds nothing twice', async () => {
  await init();
  const out = await init();
  expect(out).toBe('Skipped tagreeve/scenarios/: it exists\nSkipped tagreeve/baselines/: it exists\nSkipped .gitignore: it already has /tagreeve/runs/\n');
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
