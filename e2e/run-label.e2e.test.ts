import { execFile } from 'node:child_process';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRun } from '../packages/core/src/index.ts';
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

const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const failure = (r: { stdout: string; stderr: string }) => {
  let failed: unknown[] = [];
  try {
    failed = (JSON.parse(r.stdout) as { results: { pass: boolean }[] }).results.filter((x) => !x.pass);
  } catch {
    // Not a JSON summary.
  }
  return `${r.stderr}\nfailed results: ${JSON.stringify(failed)}\nstdout: ${r.stdout.slice(0, 2000)}`;
};

const runArgs = (...extra: string[]) => ['run', scenario('run-label'), '--site', site.url, '--json', ...extra];

test('run --label with no --out writes to tagreeve/runs/<date>-<label>/ and stores the label', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const before = today();
  const r = await runIn(cwd, runArgs('--label', 'ca-307-live'));
  const after = today();
  expect(r.code, failure(r)).toBe(0);
  const summary = JSON.parse(r.stdout) as { path: string; label: string };
  expect(summary.label).toBe('ca-307-live');
  const date = [before, after].find((d) => summary.path.includes(`${d}-ca-307-live`));
  expect(date).toBeDefined();
  const names = await readdir(join(cwd, 'tagreeve', 'runs', `${date}-ca-307-live`));
  expect(names.some((n) => /^run_.*\.jsonl$/.test(n))).toBe(true);
  const records = await readRun(join(cwd, summary.path));
  expect(records.run.label).toBe('ca-307-live');
  expect(records.run.recordSchemaVersion).toBe(4);
}, 120_000);

test('--label with --out uses the folder as given and still stores the label', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const r = await runIn(cwd, runArgs('--label', 'x', '--out', 'o'));
  expect(r.code, failure(r)).toBe(0);
  expect((JSON.parse(r.stdout) as { label: string }).label).toBe('x');
  const [name] = await readdir(join(cwd, 'o'));
  expect((await readRun(join(cwd, 'o', name!))).run.label).toBe('x');
  const text = await runIn(cwd, ['run', scenario('run-label'), '--site', site.url, '--label', 'x', '--out', 'o']);
  expect(text.stdout.split('\n')[0]).toBe('Label: x');
}, 120_000);

test('no label means no key in --json and no Label line', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const r = await runIn(cwd, ['run', scenario('run-label'), '--site', site.url, '--out', 'o', '--json']);
  expect(JSON.parse(r.stdout)).not.toHaveProperty('label');
  expect((await runIn(cwd, ['run', scenario('run-label'), '--site', site.url, '--out', 'o'])).stdout).not.toContain('Label:');
}, 120_000);

test('a bad label exits 2 before the browser starts', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const r = await runIn(cwd, ['run', scenario('run-label'), '--site', site.url, '--label', 'Bad_Label']);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('--label must be 1 to 40 lowercase letters, digits or hyphens, got "Bad_Label"');
});

test('a suite --stores cell record has the store, the label and the suite folder has the label', async () => {
  const cwd = await mkdtemp(join(outDir, 'cwd-'));
  const port = new URL(site.url).port;
  const stores = join(cwd, 'stores.json');
  await writeFile(stores, JSON.stringify({ storesSchemaVersion: 1, stores: [{ name: 'a', site: `http://localhost:${port}` }, { name: 'b', site: `http://127.0.0.1:${port}` }] }));
  const r = await runIn(cwd, ['suite', join(root, 'e2e/suites/stores'), '--stores', stores, '--label', 'ca-307', '--json']);
  expect(r.code, failure(r)).toBe(0);
  const manifest = JSON.parse(r.stdout) as { label: string; suiteSchemaVersion: number; id: string };
  expect(manifest).toMatchObject({ label: 'ca-307', suiteSchemaVersion: 3 });
  const [folder] = await readdir(join(cwd, 'tagreeve', 'runs'));
  expect(folder).toMatch(/^\d{4}-\d{2}-\d{2}-ca-307$/);
  const suiteDir = join(cwd, 'tagreeve', 'runs', folder!, manifest.id);
  for (const store of ['a', 'b']) {
    const run = (await readRun(join(suiteDir, `first.${store}.published.jsonl`))).run;
    expect(run).toMatchObject({ store, label: 'ca-307', variant: 'published' });
  }
}, 300_000);
