import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { defaultScenarioDir, defaultStores, formatDefaultsLine, resolveAutoconsentRules, resolveTrackerList, type DefaultUsed } from './defaults.ts';

const original = process.cwd();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pw-defaults-'));
  await mkdir(join(root, 'tagreeve'));
  process.chdir(root);
});

afterEach(() => process.chdir(original));

test('nothing exists: no default is used', async () => {
  const used: DefaultUsed[] = [];
  expect(await defaultScenarioDir(used)).toBeUndefined();
  expect(await resolveTrackerList(undefined, used)).toBeUndefined();
  expect(await resolveAutoconsentRules([], used)).toEqual([]);
  expect(await defaultStores(used)).toBeUndefined();
  expect(used).toEqual([]);
});

test('each default is used when present and recorded with its fixed relative path', async () => {
  await mkdir(join(root, 'tagreeve/scenarios'));
  await mkdir(join(root, 'tagreeve/autoconsent'));
  await writeFile(join(root, 'tagreeve/trackers.json'), '[]');
  await writeFile(join(root, 'tagreeve/stores.json'), '{}');
  await writeFile(join(root, 'tagreeve/autoconsent/b.json'), '{}');
  await writeFile(join(root, 'tagreeve/autoconsent/a.json'), '{}');
  await writeFile(join(root, 'tagreeve/autoconsent/notes.txt'), '');
  const used: DefaultUsed[] = [];
  expect(await defaultScenarioDir(used)).toBe('tagreeve/scenarios');
  expect(await resolveTrackerList(undefined, used)).toBe('tagreeve/trackers.json');
  expect(await resolveAutoconsentRules([], used)).toEqual(['tagreeve/autoconsent/a.json', 'tagreeve/autoconsent/b.json']);
  expect(await defaultStores(used)).toBe('tagreeve/stores.json');
  expect(used).toEqual([
    { setting: 'scenarios', path: 'tagreeve/scenarios' },
    { setting: 'trackerList', path: 'tagreeve/trackers.json' },
    { setting: 'autoconsentRules', path: 'tagreeve/autoconsent/a.json' },
    { setting: 'autoconsentRules', path: 'tagreeve/autoconsent/b.json' },
    { setting: 'stores', path: 'tagreeve/stores.json' },
  ]);
});

test('a flag replaces its default and nothing is merged or listed', async () => {
  await mkdir(join(root, 'tagreeve/autoconsent'));
  await writeFile(join(root, 'tagreeve/trackers.json'), '[]');
  await writeFile(join(root, 'tagreeve/autoconsent/a.json'), '{}');
  const used: DefaultUsed[] = [];
  expect(await resolveTrackerList('mine.json', used)).toBe('mine.json');
  expect(await resolveAutoconsentRules(['mine-rules.json'], used)).toEqual(['mine-rules.json']);
  expect(used).toEqual([]);
});

test('a folder where a file is expected, and a file where a folder is expected, are not defaults', async () => {
  await mkdir(join(root, 'tagreeve/trackers.json'));
  await writeFile(join(root, 'tagreeve/scenarios'), '');
  const used: DefaultUsed[] = [];
  expect(await resolveTrackerList(undefined, used)).toBeUndefined();
  expect(await defaultScenarioDir(used)).toBeUndefined();
  expect(used).toEqual([]);
});

test('the Defaults line names each default, and is absent when there is none', () => {
  expect(formatDefaultsLine(undefined)).toBeUndefined();
  expect(formatDefaultsLine([])).toBeUndefined();
  expect(
    formatDefaultsLine([
      { setting: 'trackerList', path: 'tagreeve/trackers.json' },
      { setting: 'autoconsentRules', path: 'tagreeve/autoconsent/cookiebot.json' },
    ]),
  ).toBe('Defaults: tagreeve/trackers.json (tracker list), tagreeve/autoconsent/cookiebot.json (autoconsent rules)');
});

test('a symlinked autoconsent rule file is used as a default', async () => {
  await mkdir(join(root, 'tagreeve/autoconsent'));
  await writeFile(join(root, 'shared.json'), '{}');
  await symlink(join(root, 'shared.json'), join(root, 'tagreeve/autoconsent/linked.json'));
  const used: DefaultUsed[] = [];
  expect(await resolveAutoconsentRules(undefined, used)).toEqual(['tagreeve/autoconsent/linked.json']);
});

test('a directory and a dangling link named *.json are not listed; a linked file is', async () => {
  await mkdir(join(root, 'tagreeve/autoconsent/dir.json'), { recursive: true });
  await symlink(join(root, 'missing.json'), join(root, 'tagreeve/autoconsent/dangling.json'));
  await writeFile(join(root, 'shared.json'), '{}');
  await symlink(join(root, 'shared.json'), join(root, 'tagreeve/autoconsent/linked.json'));
  const used: DefaultUsed[] = [];
  expect(await resolveAutoconsentRules(undefined, used)).toEqual(['tagreeve/autoconsent/linked.json']);
  expect(used).toEqual([{ setting: 'autoconsentRules', path: 'tagreeve/autoconsent/linked.json' }]);
});

test('a default that cannot be read throws with the fixed relative path, not the absolute one', async () => {
  if (process.getuid?.() === 0) return;
  await mkdir(join(root, 'tagreeve/autoconsent'));
  await writeFile(join(root, 'tagreeve/stores.json'), '{}');
  const message = (run: () => Promise<unknown>): Promise<string> => run().then(() => 'no error', (error: Error) => error.message);
  await chmod(join(root, 'tagreeve/autoconsent'), 0o000);
  try {
    expect(await message(() => resolveAutoconsentRules(undefined, []))).toBe('Cannot read tagreeve/autoconsent (EACCES). Fix its permissions or remove it.');
  } finally {
    await chmod(join(root, 'tagreeve/autoconsent'), 0o700);
  }
  await chmod(join(root, 'tagreeve'), 0o600);
  try {
    expect(await message(() => defaultStores([]))).toBe('Cannot read tagreeve/stores.json (EACCES). Fix its permissions or remove it.');
    expect(await message(() => resolveTrackerList(undefined, []))).toContain('tagreeve/trackers.json');
    expect(await message(() => defaultScenarioDir([]))).toContain('tagreeve/scenarios');
  } finally {
    await chmod(join(root, 'tagreeve'), 0o700);
  }
});
