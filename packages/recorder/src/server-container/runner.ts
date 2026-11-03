import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { hostname } from 'node:os';
import { isAbsolute } from 'node:path';
import type { ServerContainerErrorClass } from '@tagreeve/core';
import { isLoopbackHost } from '../guard.ts';
import { Scrubber } from '../gtm-scrub.ts';
import { baseImage, imageTag, isDigestReference, NAME_PREFIX, NODE_BIN, OWNER_HOST_LABEL, OWNER_PID_LABEL, PROBE_HOST, PROBE_SCRIPT, RELAY_SCRIPT, runDocker } from './image.ts';

export const CONFIG_ENV = 'TAGREEVE_SERVER_CONTAINER_CONFIG';
export const TEST_COMMAND_ENV = 'TAGREEVE_TEST_SERVER_CONTAINER_CMD';

export class ServerContainerError extends Error {
  readonly errorClass: ServerContainerErrorClass;

  constructor(errorClass: ServerContainerErrorClass, message: string) {
    super(message);
    this.name = 'ServerContainerError';
    this.errorClass = errorClass;
  }
}

/** A bad test seam value. The command exits 2. The message never holds the value. */
export class ServerContainerUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerContainerUsageError';
  }
}

const RELAY_PROXY_PORT = 3128;
const CONTAINER_PORT = 8080;
const CA_MOUNT = '/tagreeve/ca.pem';
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 500;
const LOG_LINES = 20;
const MIN_ENGINE_MAJOR = 26;

export type ConfigSource = { readonly kind: 'file'; readonly path: string } | { readonly kind: 'env' };

/** Reads the container config. A file must not be readable by group or others. */
export function loadContainerConfig(source: ConfigSource, env: NodeJS.ProcessEnv = process.env): string {
  let raw: string | undefined;
  if (source.kind === 'file') {
    try {
      const stat = statSync(source.path);
      if (!stat.isFile()) throw new Error('not a file');
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new ServerContainerError('configRejected', 'The server container config file must be mode 0600. Run: chmod 600 <file>');
      }
      raw = readFileSync(source.path, 'utf8');
    } catch (error) {
      if (error instanceof ServerContainerError) throw error;
      throw new ServerContainerError('configRejected', 'The server container config file cannot be read.');
    }
  } else {
    raw = env[CONFIG_ENV];
  }
  const config = (raw ?? '').trim();
  if (authPartOf(config) === undefined) {
    throw new ServerContainerError('configRejected', 'The server container config is not the base64 of id=GTM-...&env=N&auth=...');
  }
  return config;
}

function optionalConfig(source: ConfigSource, env: NodeJS.ProcessEnv): string {
  try {
    return loadContainerConfig(source, env);
  } catch {
    return '';
  }
}

function authPartOf(config: string): string | undefined {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(config)) return undefined;
  const params = new URLSearchParams(Buffer.from(config.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  if (!params.get('id')?.startsWith('GTM-')) return undefined;
  return params.get('auth') ?? '';
}

/** Redacts the config, its auth part and the proxy credential, and cuts every URL to its origin. */
export function createLogScrubber(secrets: readonly string[]): (line: string) => string {
  const scrubbers = secrets.filter((s) => s.length > 0).map((s) => new Scrubber(s));
  return (line) => {
    const cut = line.replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
      try {
        return `${new URL(url).origin}/...`;
      } catch {
        return '[url]';
      }
    });
    return scrubbers.reduce((text, scrubber) => scrubber.text(text), cut);
  };
}

/** The stand-in command from the test seam, or undefined when the seam is not in use. */
export function resolveStandInCommand(env: NodeJS.ProcessEnv, serverHosts: readonly string[]): string | undefined {
  const value = env[TEST_COMMAND_ENV];
  if (value === undefined || value === '') return undefined;
  const reject = (reason: string): never => {
    throw new ServerContainerUsageError(`${TEST_COMMAND_ENV} is not usable: ${reason}.`);
  };
  if (!isAbsolute(value)) reject('it must be an absolute path');
  let mode: number;
  try {
    const stat = statSync(value);
    if (!stat.isFile()) reject('it must be a regular file');
    mode = stat.mode;
  } catch (error) {
    if (error instanceof ServerContainerUsageError) throw error;
    return reject('the file does not exist');
  }
  if ((mode & 0o002) !== 0) reject('the file must not be world-writable');
  if (!serverHosts.every(isLoopbackHost)) reject('it works only when every serverHosts host is loopback');
  return value;
}

export interface StartOptions {
  readonly configSource: ConfigSource;
  readonly proxyPort: number;
  readonly proxyCredential: string;
  readonly proxyUsername?: string;
  /** Where the proxy listens. Used only for the stand-in; the relay finds the host itself. */
  readonly proxyHost?: string;
  readonly caPath: string;
  readonly image: string;
  readonly serverHosts: readonly string[];
  readonly runId?: string;
  readonly resolveProbeHost?: (host: string) => Promise<string>;
  readonly env?: NodeJS.ProcessEnv;
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
  /** Picks the loopback port the browser side is published on. */
  readonly pickPort?: () => Promise<number>;
}

export interface ServerContainer {
  /** `http://127.0.0.1:<port>`: where the browser's requests go. */
  readonly origin: string;
  /** The last scrubbed log lines. */
  logTail(): string[];
  /** True once the container (or the stand-in) has ended. */
  hasExited(): boolean;
  stop(): Promise<void>;
}

export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Linux: host-gateway is the bridge gateway, so the proxy binds that address. Docker Desktop reaches loopback. */
export async function findProxyListenHost(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): Promise<string> {
  if (platform !== 'linux') return '127.0.0.1';
  const result = await runDocker(['network', 'inspect', 'bridge', '--format', '{{range .IPAM.Config}}{{.Gateway}} {{end}}'], { env });
  if (result.missing) throw new ServerContainerError('dockerMissing', 'Docker is needed for --server-container.');
  const gateway = result.stdout.split(/\s+/).find((part) => net.isIPv4(part));
  if (result.code !== 0 || !gateway) throw new ServerContainerError('notReady', 'The Docker bridge address could not be found.');
  return gateway;
}

function ownerLabels(): string[] {
  return ['--label', `${OWNER_PID_LABEL}=${process.pid}`, '--label', `${OWNER_HOST_LABEL}=${hostname()}`];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface SweepOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly isAlive?: (pid: number) => boolean;
}

const OBJECT_FORMAT = `{{.ID}}\t{{.Label "${OWNER_PID_LABEL}"}}\t{{.Label "${OWNER_HOST_LABEL}"}}`;

/** Removes labelled containers and networks whose owner process on this host is gone. Returns the removed IDs. */
export async function sweepOrphans(options: SweepOptions = {}): Promise<string[]> {
  const host = options.host ?? hostname();
  const alive = options.isAlive ?? pidAlive;
  const removed: string[] = [];
  const kinds = [
    { list: ['ps', '-a'], remove: ['rm', '-f'] },
    { list: ['network', 'ls'], remove: ['network', 'rm'] },
  ];
  for (const kind of kinds) {
    const listing = await runDocker([...kind.list, '--filter', `label=${OWNER_PID_LABEL}`, '--format', OBJECT_FORMAT], { env: options.env });
    if (listing.code !== 0) continue;
    for (const line of listing.stdout.split('\n')) {
      const [id, pidText, ownerHost] = line.split('\t');
      if (!id || !pidText || ownerHost !== host || !/^\d+$/.test(pidText)) continue;
      const pid = Number(pidText);
      if (pid === process.pid || alive(pid)) continue;
      const result = await runDocker([...kind.remove, id], { env: options.env });
      if (result.code === 0) removed.push(id);
    }
  }
  return removed;
}

async function resolveIPv4(host: string): Promise<string> {
  return (await lookup(host, { family: 4 })).address;
}

function probeHealth(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${origin}/healthz`, { timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

interface LogFollower {
  readonly process: ChildProcess;
  readonly ended: () => boolean;
}

function followOutput(child: ChildProcess, push: (line: string) => void): LogFollower {
  let ended = false;
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      lines.forEach(push);
    });
    stream?.on('end', () => {
      if (pending) push(pending);
    });
  }
  child.on('exit', () => {
    ended = true;
  });
  child.on('error', () => {
    ended = true;
  });
  return { process: child, ended: () => ended };
}

const DOCKER_INSTALL_URL = 'https://docs.docker.com/get-docker/';

export interface HostCheckOptions {
  readonly image: string;
  readonly env?: NodeJS.ProcessEnv;
}

/** The checks that need no run: Docker is there, the engine is new enough and the image is built. */
export async function checkServerContainerHost(options: HostCheckOptions): Promise<void> {
  const env = options.env ?? process.env;
  const version = await runDocker(['version', '--format', '{{.Server.Version}}'], { env, timeoutMs: 30_000 });
  if (version.missing || version.code !== 0) {
    throw new ServerContainerError('dockerMissing', `Docker is needed for --server-container. Install it from ${DOCKER_INSTALL_URL}`);
  }
  const major = Number(/^(\d+)\./.exec(version.stdout.trim())?.[1]);
  if (Number.isInteger(major) && major < MIN_ENGINE_MAJOR) {
    throw new ServerContainerError('egressOpen', `Docker Engine ${version.stdout.trim()} forwards DNS from internal networks (CVE-2024-29018). Upgrade Docker to ${MIN_ENGINE_MAJOR} or newer.`);
  }
  if ((await runDocker(['image', 'inspect', '--format', '{{.Id}}', options.image], { env })).code !== 0) {
    throw new ServerContainerError('imageMissing', `The image ${options.image} is not available. Run: tagreeve server-container build`);
  }
}

/**
 * Starts the user's server container in Docker, or the stand-in when the test seam names one.
 * The config goes to Docker through the environment of the docker process, never through argv.
 */
export async function startServerContainer(options: StartOptions): Promise<ServerContainer> {
  const env = options.env ?? process.env;
  const standIn = resolveStandInCommand(env, options.serverHosts);
  // The stand-in needs no config; one that is present is still scrubbed from its log.
  const config = standIn === undefined ? loadContainerConfig(options.configSource, env) : optionalConfig(options.configSource, env);
  const username = options.proxyUsername ?? 'tagreeve';
  const authPart = authPartOf(config);
  const scrub = createLogScrubber([config, authPart ?? '', options.proxyCredential]);
  const lines: string[] = [];
  const push = (line: string): void => {
    lines.push(scrub(line));
    if (lines.length > LOG_LINES) lines.shift();
  };
  const tail = (): string => (lines.length > 0 ? `\nLast lines of the container log:\n${lines.join('\n')}` : '');
  const pickPort = options.pickPort ?? pickFreePort;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? READY_POLL_MS;
  // The docker client does not need the config variable, and the child gets it only for `docker run`.
  const baseEnv: NodeJS.ProcessEnv = { ...env };
  delete baseEnv[CONFIG_ENV];

  const cleanups: Array<() => Promise<void>> = [];
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => undefined);
  };

  async function waitReady(origin: string, follower: LogFollower): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (await probeHealth(origin)) return;
      if (follower.ended()) throw new ServerContainerError('exited', `The server container exited before it was ready.${tail()}`);
      if (Date.now() >= deadline) throw new ServerContainerError('notReady', `The server container was not ready after ${Math.round(readyTimeoutMs / 1000)} s.${tail()}`);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  try {
    if (standIn !== undefined) {
      const port = await pickPort();
      const proxyUrl = `http://${username}:${options.proxyCredential}@${options.proxyHost ?? '127.0.0.1'}:${options.proxyPort}`;
      const child = spawn(standIn, [], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: env.PATH ?? '', HTTP_PROXY: proxyUrl, NODE_EXTRA_CA_CERTS: options.caPath, PORT: String(port) },
      });
      const follower = followOutput(child, push);
      cleanups.push(async () => void child.kill('SIGKILL'));
      const origin = `http://127.0.0.1:${port}`;
      await waitReady(origin, follower);
      return { origin, logTail: () => [...lines], hasExited: follower.ended, stop };
    }

    const docker = (args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeoutMs?: number) => runDocker(args, { env: { ...baseEnv, ...extraEnv }, timeoutMs });

    await checkServerContainerHost({ image: options.image, env: baseEnv });
    await sweepOrphans({ env: baseEnv });

    const runId = options.runId ?? randomBytes(4).toString('hex');
    const names = {
      network: `${NAME_PREFIX}net-${runId}`,
      probe: `${NAME_PREFIX}probe-${runId}`,
      relay: `${NAME_PREFIX}relay-${runId}`,
      container: `${NAME_PREFIX}${runId}`,
    };
    const labels = ownerLabels();

    const created = await docker(['network', 'create', '--internal', ...labels, names.network]);
    if (created.code !== 0) throw new ServerContainerError('notReady', 'The internal Docker network could not be created.');
    cleanups.push(async () => void (await docker(['network', 'rm', names.network])));

    let probeAddress: string;
    try {
      probeAddress = await (options.resolveProbeHost ?? resolveIPv4)(PROBE_HOST);
    } catch {
      throw new ServerContainerError('notReady', `${PROBE_HOST} could not be resolved here, so the egress check cannot run. The container was not started.`);
    }
    if (!net.isIPv4(probeAddress)) throw new ServerContainerError('notReady', `${PROBE_HOST} did not resolve to an IPv4 address. The container was not started.`);

    const probe = await docker(['run', '--rm', '--name', names.probe, '--network', names.network, ...labels, '--entrypoint', NODE_BIN, options.image, '-e', PROBE_SCRIPT, probeAddress], {}, 60_000);
    let outcome: { connect?: unknown; dns?: unknown } | undefined;
    try {
      outcome = JSON.parse(probe.stdout.trim().split('\n').pop() ?? '') as { connect?: unknown; dns?: unknown };
    } catch {
      outcome = undefined;
    }
    if (!outcome || outcome.connect !== false || outcome.dns !== false) {
      throw new ServerContainerError('egressOpen', `The internal network is not closed: a direct connection or a DNS lookup of ${PROBE_HOST} got out, or the check did not finish. The container was not started.`);
    }

    const publishedPort = await pickPort();
    const relay = await docker([
      'run', '-d', '--rm', '--name', names.relay, ...labels,
      '--add-host', 'host.docker.internal:host-gateway',
      '-p', `127.0.0.1:${publishedPort}:${CONTAINER_PORT}`,
      '-e', `RELAY_MAP=${RELAY_PROXY_PORT}=host.docker.internal:${options.proxyPort},${CONTAINER_PORT}=${names.container}:${CONTAINER_PORT}`,
      '--entrypoint', NODE_BIN, options.image, '-e', RELAY_SCRIPT,
    ]);
    if (relay.code !== 0) throw new ServerContainerError('notReady', 'The relay container could not be started.');
    cleanups.push(async () => void (await docker(['rm', '-f', names.relay])));
    const joined = await docker(['network', 'connect', names.network, names.relay]);
    if (joined.code !== 0) throw new ServerContainerError('notReady', 'The relay container could not join the internal network.');

    const proxyUrl = `http://${username}:${options.proxyCredential}@${names.relay}:${RELAY_PROXY_PORT}`;
    const started = await docker(
      [
        'run', '-d', '--rm', '--name', names.container, '--network', names.network, ...labels,
        '-e', 'CONTAINER_CONFIG', '-e', 'HTTP_PROXY', '-e', `NODE_EXTRA_CA_CERTS=${CA_MOUNT}`,
        '-v', `${options.caPath}:${CA_MOUNT}:ro`,
        options.image,
      ],
      { CONTAINER_CONFIG: config, HTTP_PROXY: proxyUrl },
    );
    if (started.code !== 0) throw new ServerContainerError('notReady', `The server container could not be started.\n${started.stderr.split('\n').map(scrub).slice(-LOG_LINES).join('\n')}`);
    cleanups.push(async () => void (await docker(['rm', '-f', names.container])));

    const child = spawn('docker', ['logs', '--follow', names.container], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: baseEnv });
    const follower = followOutput(child, push);
    cleanups.push(async () => void child.kill('SIGKILL'));
    const origin = `http://127.0.0.1:${publishedPort}`;
    await waitReady(origin, follower);
    return { origin, logTail: () => [...lines], hasExited: follower.ended, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** On arm64 the image is the one `server-container build` made. Elsewhere it is Google's, pinned by digest. */
export function defaultServerContainerImage(version: string, env: NodeJS.ProcessEnv = process.env, arch: string = process.arch): string {
  if (arch === 'arm64') return imageTag(version);
  try {
    return baseImage(env);
  } catch (error) {
    throw new ServerContainerUsageError((error as Error).message);
  }
}

export async function describeImage(image: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (isDigestReference(image)) return image;
  const inspected = await runDocker(['image', 'inspect', '--format', '{{.Id}}', image], { env });
  const id = inspected.stdout.trim();
  return inspected.code === 0 && id ? `${image}@${id}` : image;
}
