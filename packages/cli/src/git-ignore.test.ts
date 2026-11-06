import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { gitIgnoreStatus, isUnignoredInWorkTree, warnIfNotIgnored } from './git-ignore.ts';

const exec = promisify(execFile);
let dir: string;
const originalPath = process.env.PATH;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'git-ignore-'));
});
afterEach(async () => {
  process.env.PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

async function initRepo(): Promise<void> {
  await exec('git', ['init', '-q', dir]);
}

test('a folder under a "/tagreeve/runs/" rule is ignored, before and after it exists', async () => {
  await initRepo();
  await writeFile(join(dir, '.gitignore'), '/tagreeve/runs/\n');
  expect(await isUnignoredInWorkTree(join(dir, 'tagreeve/runs/2026-11-04'))).toBe(false);
  await mkdir(join(dir, 'tagreeve/runs/2026-11-04'), { recursive: true });
  expect(await isUnignoredInWorkTree(join(dir, 'tagreeve/runs/2026-11-04'))).toBe(false);
});

test('a folder git would commit is not ignored', async () => {
  await initRepo();
  await writeFile(join(dir, '.gitignore'), '/tagreeve/runs/\n');
  expect(await isUnignoredInWorkTree(join(dir, 'records'))).toBe(true);
  await mkdir(join(dir, 'records'));
  expect(await isUnignoredInWorkTree(join(dir, 'records'))).toBe(true);
});

test('outside a work tree the answer is unknown and no warning is printed', async () => {
  expect(await gitIgnoreStatus(join(dir, 'records'))).toBe('unknown');
  const lines: string[] = [];
  await warnIfNotIgnored(join(dir, 'records'), (t) => lines.push(t));
  expect(lines).toEqual([]);
});

test('a missing git on PATH is silent', async () => {
  await initRepo();
  expect(await isUnignoredInWorkTree(join(dir, 'records'))).toBe(true);
  process.env.PATH = join(dir, 'no-bin');
  expect(await isUnignoredInWorkTree(join(dir, 'records'))).toBe(false);
});

test('the warning names the folder', async () => {
  await initRepo();
  const lines: string[] = [];
  await warnIfNotIgnored(join(dir, 'records'), (t) => lines.push(t));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toBe(`Warning: ${join(dir, 'records')} is not in .gitignore. Records hold full request bodies; do not commit them. Run tagreeve init or add the folder to .gitignore.\n`);
});

test.each(['records/**', 'records/*', '*.jsonl'])('the rule "%s" ignores the records, so an existing folder gives no warning', async (rule) => {
  await initRepo();
  await writeFile(join(dir, '.gitignore'), `${rule}\n`);
  expect(await isUnignoredInWorkTree(join(dir, 'records'))).toBe(false);
  await mkdir(join(dir, 'records'));
  expect(await isUnignoredInWorkTree(join(dir, 'records'))).toBe(false);
  const lines: string[] = [];
  await warnIfNotIgnored(join(dir, 'records'), (t) => lines.push(t));
  expect(lines).toEqual([]);
});

test('a run_*.jsonl rule counts as ignoring run records', async () => {
  await initRepo();
  await writeFile(join(dir, '.gitignore'), 'run_*.jsonl\n');
  expect(await gitIgnoreStatus(join(dir, 'records'))).toBe('ignored');
});

test('the folder probe asks about the folder itself', async () => {
  await initRepo();
  await writeFile(join(dir, '.gitignore'), '*.jsonl\n');
  expect(await gitIgnoreStatus(join(dir, 'records'))).toBe('ignored');
  expect(await gitIgnoreStatus(join(dir, 'records'), { probe: 'folder' })).toBe('unignored');
  await writeFile(join(dir, '.gitignore'), 'records/\n');
  expect(await gitIgnoreStatus(join(dir, 'records'), { probe: 'folder' })).toBe('ignored');
});
