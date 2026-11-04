import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { OLD_RUNS_NOTICE, oldRunsNotice, resolveOutDir } from './out-dir.ts';

let dir: string;
const originalTz = process.env.TZ;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'out-dir-'));
});
afterEach(async () => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  await rm(dir, { recursive: true, force: true });
});

test('an explicit --out is returned as given', () => {
  expect(resolveOutDir({ out: 'x', now: new Date() })).toBe('x');
});

test('the default folder uses the local date', () => {
  const now = new Date('2026-11-04T23:30:00Z');
  process.env.TZ = 'Pacific/Auckland';
  expect(resolveOutDir({ out: undefined, now })).toBe(join('tagreeve', 'runs', '2026-11-05'));
  process.env.TZ = 'America/Los_Angeles';
  expect(resolveOutDir({ out: undefined, now })).toBe(join('tagreeve', 'runs', '2026-11-04'));
});

test('a label is added to the default folder name and ignored with --out', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  process.env.TZ = 'UTC';
  expect(resolveOutDir({ out: undefined, now, label: 'ca-307-live' })).toBe(join('tagreeve', 'runs', '2026-11-04-ca-307-live'));
  expect(resolveOutDir({ out: 'o', now, label: 'ca-307-live' })).toBe('o');
});

test('a config base gets the dated folder and the label, and --out still wins', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  process.env.TZ = 'UTC';
  expect(resolveOutDir({ out: undefined, now, base: 'records' })).toBe(join('records', '2026-11-04'));
  expect(resolveOutDir({ out: undefined, now, base: 'records', label: 'x1' })).toBe(join('records', '2026-11-04-x1'));
  expect(resolveOutDir({ out: 'o', now, base: 'records' })).toBe('o');
});

test('no notice without a runs folder', async () => {
  expect(await oldRunsNotice(dir)).toBeUndefined();
});

test('no notice when runs holds no records', async () => {
  await mkdir(join(dir, 'runs'));
  await writeFile(join(dir, 'runs', 'notes.txt'), '');
  expect(await oldRunsNotice(dir)).toBeUndefined();
});

test('a notice when runs holds a run record', async () => {
  await mkdir(join(dir, 'runs'));
  await writeFile(join(dir, 'runs', 'run_old.jsonl'), '');
  expect(await oldRunsNotice(dir)).toBe(OLD_RUNS_NOTICE);
});

test('a notice when runs holds a suite folder', async () => {
  await mkdir(join(dir, 'runs', 'suite_old'), { recursive: true });
  expect(await oldRunsNotice(dir)).toBe(OLD_RUNS_NOTICE);
});
