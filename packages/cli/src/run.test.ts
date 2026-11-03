import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { RunArgs } from './args.ts';
import { parseScenario } from '@tagreeve/expect';
import { prepareServerContainer, resolveNetwork, runCommand } from './run.ts';

test('--var for an inherited name exits 2 as undeclared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-run-'));
  const scenario = join(dir, 's.yaml');
  await writeFile(scenario, 'start: /\nvars:\n  product: tee\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n');
  const err: string[] = [];
  const code = await runCommand({ scenario, vars: { constructor: '1' }, out: dir } as unknown as RunArgs, {
    stdout: () => undefined,
    stderr: (t) => err.push(t),
  });
  expect(err.join('')).toContain('--var constructor not declared');
  expect(code).toBe(2);
});

async function netLogRun(options: string, extra: Partial<RunArgs>) {
  const dir = await mkdtemp(join(tmpdir(), 'pw-run-'));
  const scenario = join(dir, 's.yaml');
  await writeFile(scenario, `start: /\n${options}steps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n`);
  const err: string[] = [];
  const args = { scenario, vars: {}, out: dir, netLog: true, gtmOverride: join(dir, 'missing.json'), ...extra } as unknown as RunArgs;
  const code = await runCommand(args, { stdout: () => undefined, stderr: (t) => err.push(t) });
  return { code, err: err.join('') };
}

test('--net-log is refused when the scenario runs in stub mode', async () => {
  const { code, err } = await netLogRun('', {});
  expect(code).toBe(2);
  expect(err).toContain('--net-log needs --network live');
});

test('--net-log is refused when --network stub overrides a live scenario', async () => {
  const { code, err } = await netLogRun('options:\n  network: live\n', { network: 'stub' });
  expect(code).toBe(2);
  expect(err).toContain('--net-log needs --network live');
});

test('--net-log is accepted when the scenario sets network: live', async () => {
  const { err } = await netLogRun('options:\n  network: live\n', {});
  expect(err).not.toContain('--net-log needs --network live');
  expect(err).toContain('live mode');
});

function resolve(options: string, args: { network?: RunArgs['network']; netLog?: boolean }) {
  const parsed = parseScenario(`start: /\n${options}steps:\n  - visit: /\n`);
  const err: string[] = [];
  const network = resolveNetwork({ network: args.network, netLog: args.netLog ?? false }, parsed, { stdout: () => undefined, stderr: (t) => err.push(t) });
  return { network, err: err.join('') };
}

test('--network server without serverHosts is refused and says what to set', () => {
  const { network, err } = resolve('', { network: 'server' });
  expect(network).toBeUndefined();
  expect(err).toContain('options.serverHosts');
});

test('server mode with a loopback host is accepted without a warning', () => {
  const { network, err } = resolve('options:\n  serverHosts: [127.0.0.1]\n', { network: 'server' });
  expect(network).toBe('server');
  expect(err).toBe('');
});

test('server mode with a hosted host warns on stderr', () => {
  const { network, err } = resolve('options:\n  network: server\n  serverHosts: [sgtm.example.com]\n', {});
  expect(network).toBe('server');
  expect(err).toContain('Warning: server mode');
  expect(err).toContain('sgtm.example.com');
});

test('--net-log stays live-only in server mode', () => {
  const { network, err } = resolve('options:\n  serverHosts: [127.0.0.1]\n', { network: 'server', netLog: true });
  expect(network).toBeUndefined();
  expect(err).toContain('--net-log needs --network live');
});

const FAKE_CONFIG = Buffer.from('id=GTM-PWTEST1&env=1&auth=pw-fixture-auth').toString('base64');

async function fakeDockerPath(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pw-docker-'));
  const bin = join(dir, 'docker');
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return dir;
}

async function prepare(args: Parameters<typeof prepareServerContainer>[0], hosts: string[], env: NodeJS.ProcessEnv) {
  const err: string[] = [];
  const spec = await prepareServerContainer(args, hosts, { stdout: () => undefined, stderr: (t) => err.push(t) }, env);
  return { spec, err: err.join('') };
}

test('--server-container is refused outside server mode', () => {
  const parsed = parseScenario('start: /\noptions:\n  serverHosts: [127.0.0.1]\nsteps:\n  - visit: /\n');
  const err: string[] = [];
  const network = resolveNetwork({ network: undefined, netLog: false, serverContainer: true }, parsed, { stdout: () => undefined, stderr: (t) => err.push(t) });
  expect(network).toBeUndefined();
  expect(err.join('')).toContain('--server-container needs --network server');
});

test('--server-container is accepted in server mode', () => {
  const parsed = parseScenario('start: /\noptions:\n  network: server\n  serverHosts: [127.0.0.1]\nsteps:\n  - visit: /\n');
  expect(resolveNetwork({ network: undefined, netLog: false, serverContainer: true }, parsed, { stdout: () => undefined, stderr: () => undefined })).toBe('server');
});

test('a run without the flag never reads the config or the seam', async () => {
  const { spec, err } = await prepare({ serverContainerConfig: '/does/not/exist' }, ['127.0.0.1'], { TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: 'not-a-url' });
  expect(spec).toBeNull();
  expect(err).toBe('');
});

test('the config comes from the environment variable and is validated before any browser starts', async () => {
  const docker = await fakeDockerPath('exit 0');
  const ok = await prepare({ serverContainer: true }, ['sgtm.example.com'], { TAGREEVE_SERVER_CONTAINER_CONFIG: FAKE_CONFIG, PATH: docker });
  expect(ok.spec).toMatchObject({ configSource: { kind: 'env' } });
  const missing = await prepare({ serverContainer: true }, ['sgtm.example.com'], {});
  expect(missing.spec).toBeUndefined();
  expect(missing.err).toContain('TAGREEVE_SERVER_CONTAINER_CONFIG');
  const bad = await prepare({ serverContainer: true }, ['sgtm.example.com'], { TAGREEVE_SERVER_CONTAINER_CONFIG: 'pw-not-a-config' });
  expect(bad.spec).toBeUndefined();
  expect(bad.err).toContain('base64');
  expect(bad.err).not.toContain('pw-not-a-config');
});

test('a config file readable by others is refused and the message holds neither the config nor the path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-config-'));
  const file = join(dir, 'secret-name-config.txt');
  await writeFile(file, FAKE_CONFIG);
  await chmod(file, 0o644);
  const open = await prepare({ serverContainer: true, serverContainerConfig: file }, ['sgtm.example.com'], {});
  expect(open.spec).toBeUndefined();
  expect(open.err).toContain('mode 0600');
  expect(open.err).not.toContain(FAKE_CONFIG);
  expect(open.err).not.toContain('secret-name');
  await chmod(file, 0o600);
  expect((await prepare({ serverContainer: true, serverContainerConfig: file }, ['sgtm.example.com'], { PATH: await fakeDockerPath('exit 0') })).spec).toMatchObject({ configSource: { kind: 'file', path: file } });
  expect((await prepare({ serverContainer: true, serverContainerConfig: join(dir, 'missing.txt') }, ['sgtm.example.com'], {})).spec).toBeUndefined();
});

test('the stand-in seam needs no config, and a bad seam value exits 2 without printing it', async () => {
  const env = { TAGREEVE_TEST_SERVER_CONTAINER_CMD: join(await fakeDockerPath('exit 0'), 'docker') };
  expect((await prepare({ serverContainer: true }, ['127.0.0.1'], env)).spec).toMatchObject({ configSource: { kind: 'env' } });
  const hosted = await prepare({ serverContainer: true }, ['sgtm.example.com'], env);
  expect(hosted.spec).toBeUndefined();
  expect(hosted.err).toContain('loopback');
  const upstream = await prepare({ serverContainer: true }, ['127.0.0.1'], { ...env, TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: 'http://pw-secret-host.example.com' });
  expect(upstream.spec).toBeUndefined();
  expect(upstream.err).not.toContain('pw-secret-host');
});

test('without Docker the check exits before any browser, names the install page and holds no config', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'pw-nodocker-'));
  const r = await prepare({ serverContainer: true }, ['sgtm.example.com'], { TAGREEVE_SERVER_CONTAINER_CONFIG: FAKE_CONFIG, PATH: empty });
  expect(r.spec).toBeUndefined();
  expect(r.err).toContain('Docker is needed for --server-container');
  expect(r.err).toContain('https://docs.docker.com/get-docker/');
  expect(r.err).not.toContain(FAKE_CONFIG);
});

test('a missing image exits before any browser and names the build command', async () => {
  const docker = await fakeDockerPath('[ "$1" = image ] && exit 1\necho 27.0.0');
  const r = await prepare({ serverContainer: true }, ['sgtm.example.com'], { TAGREEVE_SERVER_CONTAINER_CONFIG: FAKE_CONFIG, PATH: docker });
  expect(r.spec).toBeUndefined();
  expect(r.err).toContain('tagreeve server-container build');
});

test('a bad digest override of the base image exits 2', async () => {
  const r = await prepare({ serverContainer: true }, ['sgtm.example.com'], { TAGREEVE_SERVER_CONTAINER_CONFIG: FAKE_CONFIG, TAGREEVE_SERVER_CONTAINER_BASE: 'not-a-digest' });
  if (process.arch !== 'arm64') {
    expect(r.spec).toBeUndefined();
    expect(r.err).toContain('TAGREEVE_SERVER_CONTAINER_BASE');
  }
});
