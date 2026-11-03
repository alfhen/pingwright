import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeDocker } from './fake-docker.test-helper.ts';
import type { FakeDocker, FakeDockerCall, FakeDockerScript } from './fake-docker.test-helper.ts';
import { NAME_PREFIX, OWNER_HOST_LABEL, OWNER_PID_LABEL } from './image.ts';
import { ServerContainerError, ServerContainerUsageError, createLogScrubber, loadContainerConfig, pickFreePort, resolveStandInCommand, startServerContainer, sweepOrphans } from './runner.ts';
import type { StartOptions } from './runner.ts';

const AUTH = 'pw-fixture-auth';
const CONFIG = Buffer.from(`id=GTM-PWTEST1&env=1&auth=${AUTH}`).toString('base64');
const CREDENTIAL = 'pw-proxy-credential-0001';
const IMAGE = 'tagreeve-sgtm:test';

let work: string;
let fake: FakeDocker;
let health: http.Server | undefined;
let healthPort = 0;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'tagreeve-runner-test-'));
  fake = createFakeDocker();
});

afterEach(async () => {
  await new Promise<void>((resolve) => (health ? health.close(() => resolve()) : resolve()));
  health = undefined;
  rmSync(work, { recursive: true, force: true });
  rmSync(fake.dir, { recursive: true, force: true });
});

async function startHealth(): Promise<number> {
  health = http.createServer((req, res) => res.writeHead(req.url === '/healthz' ? 200 : 404).end());
  await new Promise<void>((resolve) => health!.listen(0, '127.0.0.1', resolve));
  healthPort = (health.address() as AddressInfo).port;
  return healthPort;
}

function options(script: FakeDockerScript = {}, extra: Partial<StartOptions> = {}, env: NodeJS.ProcessEnv = {}): StartOptions {
  return {
    configSource: { kind: 'env' },
    proxyPort: 4321,
    proxyCredential: CREDENTIAL,
    caPath: '/run/ca/ca.pem',
    image: IMAGE,
    serverHosts: ['sgtm.example.com'],
    runId: 'r1',
    env: fake.env(script, { TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG, ...env }),
    pickPort: () => Promise.resolve(healthPort),
    pollMs: 20,
    readyTimeoutMs: 3000,
    ...extra,
  };
}

const runCalls = (calls: FakeDockerCall[]) => calls.filter((call) => call.argv[0] === 'run');
const flagValues = (argv: string[], flag: string) => argv.flatMap((arg, i) => (arg === flag ? [argv[i + 1]!] : []));

describe('startServerContainer', () => {
  it('runs the container on an internal network, behind a relay, with the config in the environment only', async () => {
    await startHealth();
    const container = await startServerContainer(options());
    const calls = fake.calls();
    const [probe, relay, main] = runCalls(calls);

    const create = calls.find((call) => call.argv[0] === 'network' && call.argv[1] === 'create')!;
    expect(create.argv).toContain('--internal');
    const network = create.argv.at(-1)!;
    expect(network).toBe(`${NAME_PREFIX}net-r1`);

    expect(probe!.argv).toEqual(expect.arrayContaining(['--rm', '--network', network, '--entrypoint', 'node']));
    expect(probe!.argv).not.toContain('-d');

    expect(relay!.argv).toEqual(expect.arrayContaining(['-d', '--rm', '--add-host', 'host.docker.internal:host-gateway']));
    expect(flagValues(relay!.argv, '-p')).toEqual([`127.0.0.1:${healthPort}:8080`]);
    expect(relay!.argv).not.toContain('--network');
    expect(calls.some((call) => call.argv.join(' ') === `network connect ${network} ${NAME_PREFIX}relay-r1`)).toBe(true);

    expect(flagValues(main!.argv, '--network')).toEqual([network]);
    expect(main!.argv).not.toContain('-p');
    expect(main!.argv).not.toContain('--publish');
    expect(flagValues(main!.argv, '-v')).toEqual(['/run/ca/ca.pem:/tagreeve/ca.pem:ro']);
    expect(flagValues(main!.argv, '-e')).toEqual(['CONTAINER_CONFIG', 'HTTP_PROXY', 'NODE_EXTRA_CA_CERTS=/tagreeve/ca.pem']);
    expect(flagValues(main!.argv, '--name')).toEqual([`${NAME_PREFIX}r1`]);

    for (const call of [create, probe!, relay!, main!]) {
      expect(flagValues(call.argv, '--label')).toEqual([`${OWNER_PID_LABEL}=${process.pid}`, `${OWNER_HOST_LABEL}=${(await import('node:os')).hostname()}`]);
    }
    for (const name of [...flagValues(probe!.argv, '--name'), ...flagValues(relay!.argv, '--name'), ...flagValues(main!.argv, '--name')]) {
      expect(name.startsWith(NAME_PREFIX)).toBe(true);
    }

    expect(container.origin).toBe(`http://127.0.0.1:${healthPort}`);
    await container.stop();
  });

  it('keeps the config and the proxy credential out of every argv and out of every environment but the container run', async () => {
    await startHealth();
    const container = await startServerContainer(options());
    await container.stop();
    const calls = fake.calls();
    for (const call of calls) {
      const argv = call.argv.join('\n');
      for (const secret of [CONFIG, AUTH, CREDENTIAL]) expect(argv).not.toContain(secret);
    }
    const holders = calls.filter((call) => call.env.CONTAINER_CONFIG !== undefined);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.argv).toContain('CONTAINER_CONFIG');
    expect(holders[0]!.env.CONTAINER_CONFIG).toBe(CONFIG);
    expect(holders[0]!.env.HTTP_PROXY).toBe(`http://tagreeve:${CREDENTIAL}@${NAME_PREFIX}relay-r1:3128`);
    expect(calls.filter((call) => call.env.TAGREEVE_SERVER_CONTAINER_CONFIG !== undefined)).toEqual([]);
  });

  it('points the relay at the proxy port and at the container', async () => {
    await startHealth();
    const container = await startServerContainer(options());
    await container.stop();
    const relay = runCalls(fake.calls())[1]!;
    expect(flagValues(relay.argv, '-e')[0]).toBe(`RELAY_MAP=3128=host.docker.internal:4321,8080=${NAME_PREFIX}r1:8080`);
  });

  it('stop removes the container, the relay and the network', async () => {
    await startHealth();
    const container = await startServerContainer(options());
    await container.stop();
    await container.stop();
    const removals = fake.calls().filter((call) => call.argv[0] === 'rm' || (call.argv[0] === 'network' && call.argv[1] === 'rm'));
    expect(removals.map((call) => call.argv.join(' '))).toEqual([`rm -f ${NAME_PREFIX}r1`, `rm -f ${NAME_PREFIX}relay-r1`, `network rm ${NAME_PREFIX}net-r1`]);
  });

  it('stops with egressOpen before the container starts when the probe connects out', async () => {
    await startHealth();
    const error = await startServerContainer(options({ probe: '{"connect":true,"dns":false}' })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerContainerError);
    expect((error as ServerContainerError).errorClass).toBe('egressOpen');
    const calls = fake.calls();
    expect(runCalls(calls)).toHaveLength(1);
    expect(calls.some((call) => call.argv[0] === 'network' && call.argv[1] === 'rm')).toBe(true);
    expect(calls.some((call) => call.env.CONTAINER_CONFIG !== undefined)).toBe(false);
  });

  it('stops with egressOpen when only the DNS lookup gets out', async () => {
    const error = await startServerContainer(options({ probe: '{"connect":false,"dns":true}' })).catch((e: unknown) => e);
    expect((error as ServerContainerError).errorClass).toBe('egressOpen');
  });

  it('stops with egressOpen when the probe prints nothing usable', async () => {
    const error = await startServerContainer(options({ probe: 'oops' })).catch((e: unknown) => e);
    expect((error as ServerContainerError).errorClass).toBe('egressOpen');
  });

  it('always stops on Docker Engine before 26 and says to upgrade', async () => {
    const error = (await startServerContainer(options({ version: '25.0.5' })).catch((e: unknown) => e)) as ServerContainerError;
    expect(error.errorClass).toBe('egressOpen');
    expect(error.message).toContain('Upgrade Docker');
    expect(fake.calls().some((call) => call.argv[0] === 'network')).toBe(false);
  });

  it('classifies a missing image', async () => {
    const error = (await startServerContainer(options({ noImage: true })).catch((e: unknown) => e)) as ServerContainerError;
    expect(error.errorClass).toBe('imageMissing');
    expect(error.message).toContain('tagreeve server-container build');
  });

  it('classifies a missing docker command', async () => {
    const error = (await startServerContainer({ ...options(), env: { PATH: work, TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG } }).catch((e: unknown) => e)) as ServerContainerError;
    expect(error.errorClass).toBe('dockerMissing');
  });

  it('classifies a rejected config before any docker command', async () => {
    const error = (await startServerContainer(options({}, {}, { TAGREEVE_SERVER_CONTAINER_CONFIG: 'not base64!' })).catch((e: unknown) => e)) as ServerContainerError;
    expect(error.errorClass).toBe('configRejected');
    expect(error.message).not.toContain('not base64');
    expect(fake.calls()).toEqual([]);
  });

  it('classifies an exited container and scrubs the log it shows', async () => {
    const lines = [`Config: ${CONFIG}`, `Failed to fetch https://www.googletagmanager.com/server.js?id=GTM-PWTEST1&gtm_auth=${AUTH}`, `auth ${AUTH} and proxy ${CREDENTIAL}`];
    const error = (await startServerContainer(options({ logs: lines, exited: true })).catch((e: unknown) => e)) as ServerContainerError;
    expect(error.errorClass).toBe('exited');
    for (const secret of [CONFIG, AUTH, CREDENTIAL, 'GTM-PWTEST1&gtm_auth', 'server.js']) expect(error.message).not.toContain(secret);
    expect(error.message).toContain('https://www.googletagmanager.com');
    const removed = fake.calls().filter((call) => call.argv[0] === 'rm' || (call.argv[0] === 'network' && call.argv[1] === 'rm'));
    expect(removed).toHaveLength(3);
  });

  it('classifies a container that never answers its health check', async () => {
    const started = Date.now();
    const error = (await startServerContainer(options({}, { readyTimeoutMs: 300 })).catch((e: unknown) => e)) as ServerContainerError;
    expect(error.errorClass).toBe('notReady');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('sweeps stale objects before it creates anything', async () => {
    await startHealth();
    const container = await startServerContainer(options());
    await container.stop();
    const names = fake.calls().map((call) => call.argv.slice(0, 2).join(' '));
    expect(names.indexOf('ps -a')).toBeGreaterThan(-1);
    expect(names.indexOf('ps -a')).toBeLessThan(names.indexOf('network create'));
  });
});

describe('sweepOrphans', () => {
  const host = 'this-host';
  const alive = (pid: number) => pid === 111;

  it('removes only labelled containers and networks whose owner on this host is gone', async () => {
    const listing = [
      'c-alive\t111\tthis-host',
      'c-dead\t222\tthis-host',
      'c-unlabelled\t\t',
      'c-elsewhere\t222\tother-host',
      `c-self\t${process.pid}\tthis-host`,
      'c-bad-pid\tabc\tthis-host',
    ].join('\n');
    const removed = await sweepOrphans({ env: fake.env({ ps: listing, networks: 'n-dead\t222\tthis-host\nn-alive\t111\tthis-host\nn-other\t222\tother-host' }), host, isAlive: alive });
    expect(removed).toEqual(['c-dead', 'n-dead']);
    const removals = fake.calls().filter((call) => call.argv.includes('rm'));
    expect(removals.map((call) => call.argv.join(' '))).toEqual(['rm -f c-dead', 'network rm n-dead']);
  });

  it('asks Docker only for objects that carry the owner label', async () => {
    await sweepOrphans({ env: fake.env(), host, isAlive: alive });
    for (const call of fake.calls()) expect(flagValues(call.argv, '--filter')).toEqual([`label=${OWNER_PID_LABEL}`]);
  });
});

describe('createLogScrubber', () => {
  const scrub = createLogScrubber([CONFIG, AUTH, CREDENTIAL]);

  it('redacts the config', () => {
    expect(scrub(`CONTAINER_CONFIG=${CONFIG}`)).not.toContain(CONFIG);
  });

  it('redacts the decoded auth part', () => {
    expect(scrub(`token ${AUTH} rejected`)).not.toContain(AUTH);
  });

  it('cuts a URL that holds both to its origin', () => {
    const line = `GET https://www.googletagmanager.com/server.js?id=GTM-PWTEST1&gtm_auth=${AUTH}&config=${CONFIG} failed`;
    const out = scrub(line);
    expect(out).toBe('GET https://www.googletagmanager.com/... failed');
  });

  it('leaves a harmless line alone', () => {
    expect(scrub('listening on 8080')).toBe('listening on 8080');
  });
});

describe('loadContainerConfig', () => {
  it('reads a 0600 file', () => {
    const file = join(work, 'config');
    writeFileSync(file, `${CONFIG}\n`, { mode: 0o600 });
    expect(loadContainerConfig({ kind: 'file', path: file })).toBe(CONFIG);
  });

  it.each([0o644, 0o640, 0o604])('rejects a file with mode %o', (mode) => {
    const file = join(work, 'config');
    writeFileSync(file, CONFIG);
    chmodSync(file, mode);
    expect(() => loadContainerConfig({ kind: 'file', path: file })).toThrow(/0600/);
  });

  it('reads the environment variable and rejects a value that is not a container config', () => {
    expect(loadContainerConfig({ kind: 'env' }, { TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG })).toBe(CONFIG);
    expect(() => loadContainerConfig({ kind: 'env' }, {})).toThrow(ServerContainerError);
    expect(() => loadContainerConfig({ kind: 'env' }, { TAGREEVE_SERVER_CONTAINER_CONFIG: Buffer.from('id=other').toString('base64') })).toThrow(ServerContainerError);
  });
});

describe('the stand-in seam', () => {
  const seam = (file: string) => ({ TAGREEVE_TEST_SERVER_CONTAINER_CMD: file });

  function script(mode = 0o755): string {
    const file = join(work, 'stand-in');
    writeFileSync(file, `#!${process.execPath}\nrequire('node:http').createServer((req, res) => res.end(JSON.stringify(process.env))).listen(Number(process.env.PORT), '127.0.0.1');\n`);
    chmodSync(file, mode);
    return file;
  }

  it('is off without the variable', () => {
    expect(resolveStandInCommand({}, ['localhost'])).toBeUndefined();
  });

  it('accepts an absolute executable file when every host is loopback', () => {
    const file = script();
    expect(resolveStandInCommand(seam(file), ['localhost', '127.0.0.1', '::1'])).toBe(file);
  });

  it('rejects a relative path', () => {
    expect(() => resolveStandInCommand(seam('stand-in'), ['localhost'])).toThrow(ServerContainerUsageError);
  });

  it('rejects a missing file and a directory', () => {
    expect(() => resolveStandInCommand(seam(join(work, 'missing')), ['localhost'])).toThrow(ServerContainerUsageError);
    expect(() => resolveStandInCommand(seam(work), ['localhost'])).toThrow(ServerContainerUsageError);
  });

  it('rejects a world-writable file', () => {
    expect(() => resolveStandInCommand(seam(script(0o777)), ['localhost'])).toThrow(ServerContainerUsageError);
  });

  it('rejects a serverHosts list with a host that is not loopback', () => {
    expect(() => resolveStandInCommand(seam(script()), ['localhost', 'sgtm.example.com'])).toThrow(ServerContainerUsageError);
  });

  it('never prints the path', () => {
    const file = join(work, 'missing-secret-path');
    try {
      resolveStandInCommand(seam(file), ['localhost']);
    } catch (error) {
      expect((error as Error).message).not.toContain(file);
    }
    expect.assertions(1);
  });

  it('starts the stand-in without docker, with the upper-case proxy variable only and no config', async () => {
    const env = { PATH: work, ...seam(script()), TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG };
    const container = await startServerContainer({ ...options(), serverHosts: ['localhost'], env, pickPort: pickFreePort });
    try {
      const seen = (await (await fetch(`${container.origin}/`)).json()) as Record<string, string>;
      expect(Object.keys(seen).filter((k) => !k.startsWith('__'))).toEqual(expect.arrayContaining(['HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'PORT']));
      expect(Object.keys(seen).filter((k) => !k.startsWith('__')).sort()).toEqual(['HTTP_PROXY', 'NODE_EXTRA_CA_CERTS', 'PATH', 'PORT']);
      expect(seen.HTTP_PROXY).toBe(`http://tagreeve:${CREDENTIAL}@127.0.0.1:4321`);
      expect(seen.NODE_EXTRA_CA_CERTS).toBe('/run/ca/ca.pem');
      expect(JSON.stringify(seen)).not.toContain(CONFIG);
    } finally {
      await container.stop();
    }
  });

  it('never starts the stand-in for a non-loopback serverHosts list', async () => {
    const env = { PATH: work, ...seam(script()) };
    await expect(startServerContainer({ ...options(), env })).rejects.toBeInstanceOf(ServerContainerUsageError);
  });
});
