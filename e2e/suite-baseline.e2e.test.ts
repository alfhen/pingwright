import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const suiteDir = join(root, 'e2e/suites/baseline');

interface Cell {
  scenario: string;
  labels: Record<string, string>;
  status: string;
  exitCode: number;
  record?: string;
  baseline?: { file: string; drift: boolean; added: number; removed: number; countChanges: number };
}

let site: FixtureSite;
let work: string;
let proj: string;
let storesFile: string;

function node(args: string[], cwd = proj) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd, env: process.env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const exists = (path: string) => access(path).then(() => true, () => false);

async function readManifest(out: string): Promise<{ dir: string; text: string; cells: Cell[] }> {
  const [name] = await readdir(out);
  const dir = join(out, name!);
  const text = await readFile(join(dir, 'suite.json'), 'utf8');
  return { dir, text, cells: (JSON.parse(text) as { cells: Cell[] }).cells };
}

beforeAll(async () => {
  site = await startFixtureSite();
  const port = new URL(site.url).port;
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  work = await mkdtemp(join(parent, 'suite-baseline-'));
  proj = join(work, 'proj');
  await mkdir(proj);
  storesFile = join(work, 'stores.json');
  await writeFile(
    storesFile,
    JSON.stringify({
      storesSchemaVersion: 1,
      stores: [
        { name: 'a', site: `http://localhost:${port}` },
        { name: 'b', site: `http://127.0.0.1:${port}` },
      ],
    }),
  );
});

afterAll(async () => {
  await site?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

test('baseline save with one path names the file after the scenario and the store, and suite --baseline checks every cell', async () => {
  const first = join(work, 'first');
  const suite = await node(['suite', suiteDir, '--stores', storesFile, '--out', first]);
  expect(suite.code, suite.stderr).toBe(0);
  const { dir, cells } = await readManifest(first);
  expect(cells).toHaveLength(4);
  expect(cells.every((c) => c.baseline === undefined)).toBe(true);

  const never = join(work, 'never');
  const missingFirst = await node(['suite', suiteDir, '--stores', storesFile, '--out', never, '--baseline']);
  expect(missingFirst.code).toBe(2);
  expect(await exists(never)).toBe(false);
  for (const file of ['cart.a.json', 'cart.b.json', 'home.a.json', 'home.b.json']) expect(missingFirst.stderr).toContain(join('tagreeve/baselines', file));

  for (const cell of cells) {
    const saved = await node(['baseline', 'save', join(dir, cell.record!)]);
    expect(saved.code, saved.stderr).toBe(0);
    expect(saved.stdout).toContain(`tagreeve/baselines/${cell.scenario}.${cell.labels.store}.json`);
  }
  expect((await readdir(join(proj, 'tagreeve/baselines'))).sort()).toEqual(['cart.a.json', 'cart.b.json', 'home.a.json', 'home.b.json']);

  const clean = await node(['suite', suiteDir, '--stores', storesFile, '--out', join(work, 'clean'), '--baseline']);
  expect(clean.code, clean.stderr).toBe(0);
  expect(clean.stdout).toContain('tagreeve/baselines (baseline)');
  const cleanCells = (await readManifest(join(work, 'clean'))).cells;
  expect(cleanCells).toHaveLength(4);
  for (const c of cleanCells) expect(c.baseline).toMatchObject({ drift: false, added: 0, removed: 0 });

  const file = join(proj, 'tagreeve/baselines/cart.b.json');
  const baseline = JSON.parse(await readFile(file, 'utf8')) as { keys: { key: { event: string } }[] };
  const before = baseline.keys.length;
  baseline.keys = baseline.keys.filter((k) => k.key.event !== 'add_to_cart');
  expect(baseline.keys.length).toBe(before - 1);
  await writeFile(file, JSON.stringify(baseline));

  const drift = await node(['suite', suiteDir, '--stores', storesFile, '--out', join(work, 'drift'), '--baseline']);
  expect(drift.code, drift.stderr).toBe(1);
  expect(drift.stdout).toMatch(/cart\s+b\s+FAIL \(baseline drift\)/);
  expect(drift.stdout).toMatch(/home\s+b\s+PASS/);
  const { dir: driftDir, text, cells: driftCells } = await readManifest(join(work, 'drift'));
  const cart = driftCells.find((c) => c.scenario === 'cart' && c.labels.store === 'b')!;
  expect(cart).toMatchObject({ status: 'fail', exitCode: 1, baseline: { file: 'cart.b.json', drift: true, added: 1 } });
  expect(driftCells.filter((c) => c.baseline?.drift)).toHaveLength(1);
  expect(JSON.parse(text)).toMatchObject({ suiteSchemaVersion: 3, exitCode: 1 });
  const driftRecord = await readFile(join(driftDir, cart.record!), 'utf8');
  const secrets = ['7777777777.8888888888', '7777777777'];
  for (const secret of secrets) expect(driftRecord).toContain(secret);
  for (const output of [drift.stdout, drift.stderr, text]) {
    for (const secret of secrets) expect(output).not.toContain(secret);
  }

  const without = await node(['suite', suiteDir, '--stores', storesFile, '--out', join(work, 'without')]);
  expect(without.code, without.stderr).toBe(0);

  const folder = join(work, 'moved');
  await mkdir(folder);
  const given = await node(['suite', suiteDir, '--stores', storesFile, '--out', join(work, 'given'), '--baseline', folder]);
  expect(given.code).toBe(2);
  expect(given.stderr).toContain(join(folder, 'cart.a.json'));
}, 600_000);

test('run with a bare --baseline after the scenario uses tagreeve/baselines/<scenario>.json', async () => {
  const scenarioFile = join(suiteDir, 'home.yml');
  const out = join(work, 'run-out');
  await rm(join(proj, 'tagreeve/baselines/home.json'), { force: true });
  const missing = await node(['run', scenarioFile, '--site', site.url, '--out', out, '--baseline']);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('tagreeve/baselines/home.json');

  const record = await node(['run', scenarioFile, '--site', site.url, '--out', out, '--json']);
  expect(record.code, record.stderr).toBe(0);
  const saved = await node(['baseline', 'save', (JSON.parse(record.stdout) as { path: string }).path]);
  expect(saved.code, saved.stderr).toBe(0);
  expect(saved.stdout).toContain('tagreeve/baselines/home.json');

  const compared = await node(['run', scenarioFile, '--site', site.url, '--out', out, '--json', '--baseline']);
  expect(compared.code, compared.stderr).toBe(0);
  const summary = JSON.parse(compared.stdout) as { baseline: { drift: boolean }; defaults: { setting: string; path: string }[] };
  expect(summary.baseline.drift).toBe(false);
  expect(summary.defaults).toContainEqual({ setting: 'baseline', path: 'tagreeve/baselines/home.json' });
}, 300_000);
