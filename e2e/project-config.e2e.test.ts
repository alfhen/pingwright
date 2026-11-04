import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { root, scenario, site } from './cli-helpers.ts';

const cli = join(root, 'dist/cli.js');

interface Result {
  stdout: string;
  stderr: string;
  code: number;
}

function tagreeve(cwd: string, args: string[]): Promise<Result> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ stdout, stderr, code: error ? (typeof code === 'number' ? code : 1) : 0 });
    });
  });
}

interface Summary {
  ok: boolean;
  path: string;
  results: { expectation: string; pass: boolean }[];
  defaults?: { setting: string; path: string }[];
}

const failedChecks = (s: Summary) => s.results.filter((r) => !r.pass).map((r) => r.expectation);
const UNKNOWN = 'builtin: unknownDestination';

let cwd: string;
let scenarioFile: string;
let strictFile: string;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'tagreeve-config-'));
  await mkdir(join(cwd, 'tagreeve'));
  scenarioFile = join(cwd, 'third-party-ip.yml');
  await copyFile(scenario('third-party-ip'), scenarioFile);
  strictFile = join(cwd, 'strict.yml');
  const text = await readFile(scenarioFile, 'utf8');
  await writeFile(strictFile, text.replace('options: { seed: 1 }', 'options: { seed: 1, allowUnknownDestination: false }'));
  await writeFile(
    join(cwd, 'tagreeve/config.yml'),
    `configSchemaVersion: 1\nsite: ${site.url}\nout: records\noptions:\n  allowUnknownDestination: true\n  builtins: { sandboxPageUrl: warn }\n`,
  );
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('precondition: without the config the scenario fails on unknownDestination', async () => {
  const bare = await mkdtemp(join(tmpdir(), 'tagreeve-config-bare-'));
  const r = await tagreeve(bare, ['run', scenarioFile, '--site', site.url, '--json']);
  expect(r.code, r.stderr).toBe(1);
  expect(failedChecks(JSON.parse(r.stdout) as Summary)).toContain(UNKNOWN);
  await rm(bare, { recursive: true, force: true });
}, 90_000);

test('the config supplies site, out and options, and the summary names it', async () => {
  const r = await tagreeve(cwd, ['run', scenarioFile]);
  expect(r.code, r.stdout).toBe(0);
  expect(r.stdout).toContain('Defaults: tagreeve/config.yml (project config)');
  expect(r.stdout).toMatch(/Record: records\/\d{4}-\d{2}-\d{2}\/run_/);

  const json = await tagreeve(cwd, ['run', scenarioFile, '--json']);
  expect(json.code, json.stderr).toBe(0);
  const summary = JSON.parse(json.stdout) as Summary;
  expect(summary.defaults).toContainEqual({ setting: 'config', path: 'tagreeve/config.yml' });
  expect(summary.path).toMatch(/^records\/\d{4}-\d{2}-\d{2}\/run_/);
}, 120_000);

test('a scenario option wins over the config', async () => {
  const r = await tagreeve(cwd, ['run', strictFile, '--json']);
  expect(r.code, r.stderr).toBe(1);
  expect(failedChecks(JSON.parse(r.stdout) as Summary)).toContain(UNKNOWN);
}, 90_000);

test('--config replaces tagreeve/config.yml and is not listed as a default', async () => {
  await writeFile(join(cwd, 'other.yml'), `configSchemaVersion: 1\nsite: ${site.url}\nout: other-records\n`);
  const r = await tagreeve(cwd, ['run', scenarioFile, '--config', 'other.yml', '--json']);
  expect(r.code, r.stderr).toBe(1);
  const summary = JSON.parse(r.stdout) as Summary;
  expect(failedChecks(summary)).toContain(UNKNOWN);
  expect(summary.path).toMatch(/^other-records\//);
  expect(summary.defaults ?? []).not.toContainEqual({ setting: 'config', path: 'tagreeve/config.yml' });
  expect(JSON.stringify(summary.defaults ?? [])).not.toContain('other.yml');

  const missing = await tagreeve(cwd, ['run', scenarioFile, '--config', 'missing.yml']);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('Cannot read missing.yml');
}, 120_000);

test('a config in a parent folder is not read', async () => {
  await mkdir(join(cwd, 'child'));
  const r = await tagreeve(join(cwd, 'child'), ['run', scenarioFile]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('--site is required');
});

test('a refused key exits 2 with the file, key and line and never the value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tagreeve-config-refuse-'));
  await mkdir(join(dir, 'tagreeve'));
  await writeFile(
    join(dir, 'tagreeve/config.yml'),
    `configSchemaVersion: 1\nsite: ${site.url}\ngtmOverride: "gtm_auth=FAKE-AUTH-VALUE"\nserverContainerConfig:\n  container: FAKE-CONTAINER-CONFIG\n`,
  );
  const r = await tagreeve(dir, ['run', scenarioFile, '--json']);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('tagreeve/config.yml: line 3, gtmOverride: not allowed');
  expect(r.stderr).toContain('tagreeve/config.yml: line 4, serverContainerConfig: not allowed');
  expect(r.stdout + r.stderr).not.toMatch(/FAKE-/);
  await rm(dir, { recursive: true, force: true });
});

test.each([
  ['an unresolved alias', 'options:\n  gtmOverride: *gtm_auth=FAKE-AUTH-VALUE\n', 4],
  ['an unquoted wildcard host', 'options:\n  firstPartyHosts: *.example.com\n', 4],
  ['a collection key', '? { gtmOverride: "gtm_auth=FAKE-AUTH-VALUE" }\n: x\n', 3],
  ['an alias key', 'gtmOverride: &g "gtm_auth=FAKE-AUTH"\noptions:\n  *g : true\n', 3],
])('%s exits 2 with the file and line and never the text', async (_, body, line) => {
  const dir = await mkdtemp(join(tmpdir(), 'tagreeve-config-yaml-'));
  await mkdir(join(dir, 'tagreeve'));
  await writeFile(join(dir, 'tagreeve/config.yml'), `configSchemaVersion: 1\nsite: ${site.url}\n${body}`);
  const r = await tagreeve(dir, ['run', scenarioFile, '--json']);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(`tagreeve/config.yml: line ${line}: anchors, aliases, tags and merge keys are not allowed in the project config`);
  expect(r.stderr).not.toMatch(/Warning/);
  expect(r.stdout + r.stderr).not.toMatch(/FAKE-/);
  await rm(dir, { recursive: true, force: true });
});

test('--allow-test-payment needs --site on the command line, also when the config has a site', async () => {
  const r = await tagreeve(cwd, ['run', scenarioFile, '--allow-test-payment', '127.0.0.1']);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('--allow-test-payment needs --site on the command line');
});
