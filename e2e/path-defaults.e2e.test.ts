import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, site } from './cli-helpers.ts';

const cli = join(root, 'dist/cli.js');

interface Manifest {
  stores: { name: string }[];
  cells: { scenario: string; status: string; labels: Record<string, string> }[];
  defaults?: { setting: string; path: string }[];
}

const scenarioWith = (mustNot: string): string =>
  `start: /\nsteps:\n  - consent: accept\n  - visit: /products/fake-tee\nexpect:\n  must: []\n  mustNot: ${mustNot}\noptions: { seed: 1, allowUnknownDestination: true, builtins: { sandboxPageUrl: warn } }\n`;
// Parses only when tagreeve/trackers.json is loaded, because tiktok is defined only there.
const SCENARIO = scenarioWith('[{ vendor: tiktok }]');

function tagreeve(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function project(storesSite: string): Promise<string> {
  const cwd = await mkdtemp(join(outDir, 'defaults-'));
  await mkdir(join(cwd, 'tagreeve', 'scenarios'), { recursive: true });
  await writeFile(join(cwd, 'tagreeve', 'scenarios', 'a.yml'), SCENARIO);
  await writeFile(join(cwd, 'tagreeve', 'trackers.json'), JSON.stringify([{ vendor: 'tiktok', host: 'tiktok.localhost', source: 'https://example.com/tiktok-pixel-docs' }]));
  await writeFile(
    join(cwd, 'tagreeve', 'stores.json'),
    JSON.stringify({ storesSchemaVersion: 1, stores: [{ name: 'one', site: storesSite }, { name: 'two', site: storesSite }] }),
  );
  return cwd;
}

async function suiteJson(cwd: string): Promise<string> {
  const day = (await readdir(join(cwd, 'tagreeve', 'runs')))[0]!;
  const suite = (await readdir(join(cwd, 'tagreeve', 'runs', day)))[0]!;
  return readFile(join(cwd, 'tagreeve', 'runs', day, suite, 'suite.json'), 'utf8');
}

test('suite with no folder and no site runs on each default store, and --site leaves stores.json unused', async () => {
  const cwd = await project(site.url);
  try {
    const first = await tagreeve(cwd, ['suite', '--json']);
    expect(first.code, first.stderr).toBe(0);
    const manifest = JSON.parse(first.stdout) as Manifest;
    expect(manifest.cells.map((c) => [c.scenario, c.labels.store])).toEqual([
      ['a', 'one'],
      ['a', 'two'],
    ]);
    expect(manifest.cells.map((c) => c.status)).not.toContain('error');
    expect(manifest.defaults).toEqual([
      { setting: 'scenarios', path: 'tagreeve/scenarios' },
      { setting: 'trackerList', path: 'tagreeve/trackers.json' },
      { setting: 'stores', path: 'tagreeve/stores.json' },
    ]);
    const saved = await suiteJson(cwd);
    expect(JSON.parse(saved)).toMatchObject({ defaults: manifest.defaults });
    for (const text of [first.stdout, first.stderr, saved]) {
      expect(text).not.toContain(cwd);
      expect(text).not.toContain(homedir());
    }

    const text = await tagreeve(cwd, ['suite']);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('Defaults: tagreeve/scenarios (scenario folder), tagreeve/trackers.json (tracker list), tagreeve/stores.json (stores)');

    const explicit = await tagreeve(cwd, ['suite', '--site', site.url, '--json']);
    expect(explicit.code, explicit.stderr).toBe(0);
    const withSite = JSON.parse(explicit.stdout) as Manifest;
    expect(withSite.stores).toEqual([]);
    expect(withSite.cells).toHaveLength(1);
    expect(withSite.defaults?.map((d) => d.setting)).toEqual(['scenarios', 'trackerList']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 180_000);

test('--allow-test-payment is refused with no site on the command line, even when stores.json holds the host', async () => {
  const host = new URL(site.url).hostname;
  const cwd = await project(site.url);
  const xdg = await mkdtemp(join(outDir, 'xdg-'));
  try {
    await mkdir(join(xdg, 'tagreeve'));
    const allowlist = join(xdg, 'tagreeve', 'test-payment-hosts.json');
    await writeFile(allowlist, JSON.stringify([host]));
    await chmod(allowlist, 0o600);
    const env = { XDG_CONFIG_HOME: xdg };

    const refused = await tagreeve(cwd, ['suite', '--allow-test-payment', host], env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--allow-test-payment');
    await expect(readdir(join(cwd, 'tagreeve', 'runs'))).rejects.toThrow();

    const allowed = await tagreeve(cwd, ['suite', '--site', site.url, '--allow-test-payment', host], env);
    expect(allowed.code, allowed.stderr).toBe(0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(xdg, { recursive: true, force: true });
  }
}, 180_000);

test('run loads the default tracker list and autoconsent rules and names them; the flags replace them', async () => {
  const cwd = await project(site.url);
  try {
    const rules = join(cwd, 'tagreeve', 'autoconsent', 'a.json');
    await mkdir(join(cwd, 'tagreeve', 'autoconsent'));
    await writeFile(rules, '{"autoconsent": []}');
    const scenario = join(cwd, 'tagreeve', 'scenarios', 'a.yml');
    const json = await tagreeve(cwd, ['run', scenario, '--site', site.url, '--out', join(cwd, 'out'), '--json']);
    expect(json.code, json.stderr).toBe(0);
    const summary = JSON.parse(json.stdout) as { defaults?: { setting: string; path: string }[] };
    expect(summary.defaults).toEqual([
      { setting: 'trackerList', path: 'tagreeve/trackers.json' },
      { setting: 'autoconsentRules', path: 'tagreeve/autoconsent/a.json' },
    ]);

    const text = await tagreeve(cwd, ['run', scenario, '--site', site.url, '--out', join(cwd, 'out')]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain('Defaults: tagreeve/trackers.json (tracker list), tagreeve/autoconsent/a.json (autoconsent rules)');

    await writeFile(rules, '{}');
    const broken = await tagreeve(cwd, ['run', scenario, '--site', site.url, '--out', join(cwd, 'out'), '--json']);
    expect(broken.code).toBe(2);
    expect(broken.stderr).toContain('tagreeve/autoconsent/a.json');
    await writeFile(rules, '{"autoconsent": []}');

    const own = join(cwd, 'own.json');
    await writeFile(own, JSON.stringify([{ vendor: 'tiktok', host: 'tiktok.localhost', source: 'https://example.com/tiktok-pixel-docs' }]));
    const explicit = await tagreeve(cwd, ['run', scenario, '--site', site.url, '--out', join(cwd, 'out'), '--tracker-list', own, '--json']);
    expect(explicit.code, explicit.stderr).toBe(0);
    expect((JSON.parse(explicit.stdout) as { defaults?: { setting: string }[] }).defaults?.map((d) => d.setting)).toEqual(['autoconsentRules']);

    await writeFile(rules, '{}');
    const ownRules = join(cwd, 'own-rules.json');
    await writeFile(ownRules, '{"autoconsent": []}');
    const flagged = await tagreeve(cwd, ['run', scenario, '--site', site.url, '--out', join(cwd, 'out'), '--autoconsent-rules', ownRules, '--json']);
    expect(flagged.code, flagged.stderr).toBe(0);
    expect((JSON.parse(flagged.stdout) as { defaults?: { setting: string }[] }).defaults?.map((d) => d.setting)).toEqual(['trackerList']);

    await writeFile(join(cwd, 'tagreeve', 'trackers.json'), '[]');
    const missing = await tagreeve(cwd, ['run', scenario, '--site', site.url, '--out', join(cwd, 'out'), '--json']);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('tiktok');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}, 180_000);
