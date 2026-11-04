import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScenario, mergeOptions } from '@tagreeve/expect';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { UsageError } from './args.ts';
import { formatDefaults, loadProjectConfig, ProjectConfigLoadError, siteMissingMessage } from './project-config.ts';
import { resolveNetwork, runCommand } from './run.ts';
import { suiteCommand } from './suite.ts';

const original = process.cwd();
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pw-config-'));
  await mkdir(join(root, 'tagreeve'));
  process.chdir(root);
});

afterEach(() => process.chdir(original));

const CONFIG = 'configSchemaVersion: 1\nsite: http://127.0.0.1:9\nout: records\n';

function capture() {
  const err: string[] = [];
  return { io: { stdout: () => undefined, stderr: (t: string) => void err.push(t) }, text: () => err.join('') };
}

const runArgs = {
  command: 'run' as const,
  scenario: 's.yml',
  network: undefined,
  out: undefined,
  seed: undefined,
  headed: false,
  netLog: false,
  autoconsentRules: [],
  gtmOverride: undefined,
  baseline: undefined,
  trackerList: undefined,
  vars: {},
  json: false,
};

const suiteArgs = {
  command: 'suite' as const,
  variants: [{ name: 'published' }],
  network: undefined,
  out: undefined,
  seed: undefined,
  withHandoff: false,
  withTestPayment: false,
  autoconsentRules: [],
  trackerList: undefined,
  vars: {},
  json: false,
};

test('no file in the default place: nothing is loaded', async () => {
  expect(await loadProjectConfig(undefined)).toBeUndefined();
});

test('the default file is read and listed as a default', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  const loaded = await loadProjectConfig(undefined);
  expect(loaded?.config).toMatchObject({ site: 'http://127.0.0.1:9', out: 'records' });
  expect(loaded?.defaultUsed).toEqual({ setting: 'config', path: 'tagreeve/config.yml' });
});

test('--config replaces the default file and is not listed as a default', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  await writeFile(join(root, 'other.yml'), 'configSchemaVersion: 1\nsite: http://127.0.0.1:10\n');
  const loaded = await loadProjectConfig('other.yml');
  expect(loaded?.config.site).toBe('http://127.0.0.1:10');
  expect(loaded?.defaultUsed).toBeUndefined();
});

test('a missing --config file is an error that names the file', async () => {
  await expect(loadProjectConfig('nope.yml')).rejects.toThrow(/Cannot read nope\.yml: ENOENT/);
});

test('a config in a parent folder is not read', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  await mkdir(join(root, 'sub'));
  process.chdir(join(root, 'sub'));
  expect(await loadProjectConfig(undefined)).toBeUndefined();
});

test('an invalid file is an error with the file, the key and the line, and no value', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), 'configSchemaVersion: 1\ngtmOverride: "gtm_auth=FAKE-AUTH-VALUE"\n');
  const error = await loadProjectConfig(undefined).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ProjectConfigLoadError);
  expect((error as Error).message).toContain('tagreeve/config.yml: line 2, gtmOverride');
  expect((error as Error).message).not.toContain('FAKE-AUTH-VALUE');
});

test('formatDefaults names the config first', () => {
  expect(formatDefaults(undefined)).toBeUndefined();
  expect(formatDefaults([{ setting: 'stores', path: 'tagreeve/stores.json' }, { setting: 'config', path: 'tagreeve/config.yml' }])).toBe(
    'Defaults: tagreeve/config.yml (project config), tagreeve/stores.json (stores)',
  );
});

test('the site message names the config path only when one was read', async () => {
  expect(siteMissingMessage(undefined)).toBe('--site is required');
  await writeFile(join(root, 'tagreeve/config.yml'), 'configSchemaVersion: 1\n');
  expect(siteMissingMessage(await loadProjectConfig(undefined))).toContain('set site in tagreeve/config.yml');
});

test('a scenario with network server and no serverHosts runs on the config hosts and the messages name the config', () => {
  const parsed = parseScenario('start: /\noptions:\n  network: server\nsteps:\n  - visit: /\n');
  const without = capture();
  expect(resolveNetwork({ network: undefined, netLog: false }, parsed, without.io)).toBeUndefined();
  expect(without.text()).toContain('options.serverHosts in the scenario:');
  const named = capture();
  expect(resolveNetwork({ network: undefined, netLog: false }, parsed, named.io, 'tagreeve/config.yml')).toBeUndefined();
  expect(named.text()).toContain('options.serverHosts in the scenario or in tagreeve/config.yml:');

  parsed.options = mergeOptions({ serverHosts: ['sgtm.example.com', '127.0.0.1'] }, parsed.options);
  const ok = capture();
  expect(resolveNetwork({ network: undefined, netLog: false }, parsed, ok.io, 'tagreeve/config.yml')).toBe('server');
  expect(ok.text()).toBe('Warning: server mode. Requests to sgtm.example.com reach the network.\n');
});

test('--server-container outside server mode names the config too', () => {
  const parsed = parseScenario('start: /\nsteps:\n  - visit: /\n');
  const err = capture();
  expect(resolveNetwork({ network: undefined, netLog: false, serverContainer: true }, parsed, err.io, 'tagreeve/config.yml')).toBeUndefined();
  expect(err.text()).toContain('in the scenario or in tagreeve/config.yml');
});

test('run: --allow-test-payment needs --site on the command line, also when the config has a site', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  const err = capture();
  expect(await runCommand({ ...runArgs, allowTestPayment: '127.0.0.1' }, err.io)).toBe(2);
  expect(err.text()).toContain('--allow-test-payment needs --site on the command line');
});

test('run: no site anywhere is a usage error raised before the scenario is read', async () => {
  const error = await runCommand(runArgs, capture().io).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(UsageError);
  expect((error as UsageError).command).toBe('run');
  expect((error as Error).message).toBe('--site is required');
  await writeFile(join(root, 'tagreeve/config.yml'), 'configSchemaVersion: 1\n');
  expect(((await runCommand(runArgs, capture().io).catch((e: unknown) => e)) as Error).message).toContain('--site is required');
});

test('run: the config site is used, so the scenario file is read next', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  const err = capture();
  expect(await runCommand(runArgs, err.io)).toBe(2);
  expect(err.text()).toContain('Cannot read s.yml');
});

test('run: a refused key stops the run and the value is not printed', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), 'configSchemaVersion: 1\nsite: http://127.0.0.1:9\nserverContainerConfig: "gtm_auth=FAKE-AUTH-VALUE"\n');
  const err = capture();
  expect(await runCommand(runArgs, err.io)).toBe(2);
  expect(err.text()).toContain('tagreeve/config.yml: line 3, serverContainerConfig: not allowed');
  expect(err.text()).not.toContain('FAKE-AUTH-VALUE');
});

test('suite: --allow-test-payment needs --site or --stores on the command line, also when the config has a site', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  const err = capture();
  expect(await suiteCommand({ ...suiteArgs, allowTestPayment: '127.0.0.1' }, err.io)).toBe(2);
  expect(err.text()).toContain('--allow-test-payment needs --site or --stores');
});

test('suite: a config site and a default stores.json ask for --site or --stores', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  await writeFile(join(root, 'tagreeve/stores.json'), '[]');
  await mkdir(join(root, 'tagreeve/scenarios'));
  const err = capture();
  expect(await suiteCommand(suiteArgs, err.io)).toBe(2);
  expect(err.text()).toContain('tagreeve/config.yml sets site and tagreeve/stores.json exists. Give --site or --stores');
});

test('suite: the config site stands in when there is no stores.json', async () => {
  await writeFile(join(root, 'tagreeve/config.yml'), CONFIG);
  await mkdir(join(root, 'tagreeve/scenarios'));
  const err = capture();
  expect(await suiteCommand(suiteArgs, err.io)).toBe(2);
  expect(err.text()).toContain('has no .yml or .yaml scenario files');
  expect(err.text()).not.toContain('suite needs a site');
});
