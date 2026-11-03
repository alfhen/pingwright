import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createIdentity, type Hit, type Request, type RunRecords } from '../packages/core/src/index.ts';
import { standInContainerPath } from '../fixtures/site/src/index.ts';
import { outDir, run, site, type CliRun } from './cli-helpers.ts';

const ACCESS_TOKEN = 'pw-fixture-access-token';
const AUTH = 'pw-fixture-auth';
const CONFIG = Buffer.from(`id=GTM-PWTEST1&env=1&auth=${AUTH}`).toString('base64');
const EMAIL = 'pw-fixture@example.com';
const IDENTITY_EMAIL = createIdentity(1).email;
const EMAIL_HASH = createHash('sha256').update(EMAIL).digest('hex');

let upstream: http.Server;
let upstreamUrl: string;
const forwarded: string[] = [];
let connectLog: string;
let env: Record<string, string>;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    forwarded.push(new URL(req.url ?? '/', 'http://upstream.invalid').pathname);
    res.writeHead(200, { 'content-type': 'text/plain' }).end('// fake google file');
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  await mkdir(outDir, { recursive: true });
  connectLog = join(outDir, 'connects.log');
  const preload = join(outDir, 'connect-log.mjs');
  await writeFile(
    preload,
    `import net from 'node:net';
import { appendFileSync } from 'node:fs';
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const target = typeof first === 'object' && first !== null ? (first.path ?? first.host ?? 'localhost') : typeof args[1] === 'string' ? args[1] : 'localhost';
  appendFileSync(${JSON.stringify(connectLog)}, String(target) + '\\n');
  return original.apply(this, args);
};
`,
  );
  env = {
    TAGREEVE_TEST_SERVER_CONTAINER_CMD: standInContainerPath,
    TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: upstreamUrl,
    TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG,
    NODE_OPTIONS: `--import ${preload}`,
  };
});

afterAll(async () => {
  await new Promise((resolve) => upstream?.close(resolve));
});

const fromContainer = (records: RunRecords): Request[] => records.requests.filter((r) => r.captured === 'serverContainer');
const hitsOf = (records: RunRecords, requests: Request[]): Hit[] => records.hits.filter((h) => requests.some((r) => r.id === h.requestId));

function expectNoSecrets(text: string): void {
  for (const secret of [ACCESS_TOKEN, CONFIG, AUTH]) expect(text).not.toContain(secret);
}

function expectNoEmail(text: string): void {
  for (const value of [EMAIL, EMAIL_HASH, encodeURIComponent(EMAIL)]) expect(text).not.toContain(value);
}

describe('--server-container with the stand-in container', () => {
  let first: CliRun;
  let firstText: string;

  beforeAll(async () => {
    first = await run('server-container', ['--server-container', '--var', `email=${IDENTITY_EMAIL}`], env);
    firstText = first.records ? await readFile((JSON.parse(first.stdout) as { path: string }).path, 'utf8') : '';
  }, 120_000);

  test('records one GA4, one Google Ads and one Meta Conversions API hit from the container', () => {
    expect(first.code).toBe(0);
    const records = first.records!;
    const calls = fromContainer(records);
    expect(calls).toHaveLength(3);
    expect(calls.every((r) => r.outcome === 'stubbed' && r.resourceType === 'fetch' && r.frameUrl === null && r.initiator === 'serverContainer')).toBe(true);
    expect(hitsOf(records, calls).map((h) => h.vendor).sort()).toEqual(['ga4', 'google-ads', 'meta-capi']);
    expect(records.run.serverContainer).toMatchObject({ requests: 3, refused: 0, passThrough: { serverjs: 0, config: 1, destination: 1 } });
    expect(records.run.testServerContainer).toBe(true);
    expect(JSON.parse(first.stdout)).toMatchObject({ testServerContainer: true });
  });

  test('the Conversions API hit is linked exactly to the pixel hit', () => {
    const records = first.records!;
    const pixel = records.hits.filter((h) => h.vendor === 'meta' && h.event === 'Purchase');
    expect(pixel).toHaveLength(1);
    const capi = records.hits.find((h) => h.vendor === 'meta-capi')!;
    expect(capi.via).toEqual({ hitId: pixel[0]!.id, by: 'eventId', confidence: 'exact' });
  });

  test('the container calls carry the time of the proxy and the id of the running step', () => {
    const records = first.records!;
    const started = records.steps.map((s) => ({ id: s.id, startedAt: s.startedAt }));
    for (const call of fromContainer(records)) {
      const running = started.filter((s) => s.startedAt <= call.t).at(-1);
      expect(running).toBeDefined();
      expect(call.stepId).toBe(running!.id);
      expect(call.t).toBeGreaterThanOrEqual(records.run.serverContainer!.startedAt);
    }
  });

  test('only the two Google requests reached the loopback upstream', () => {
    expect(forwarded.slice(0, 2).sort()).toEqual(['/s/gtag/destination', '/server.js']);
  });

  test('the browser hit went to the container, never to the pass-through host', () => {
    expect(site.sgtmRequests.filter((r) => r.startsWith('POST /capi'))).toEqual([]);
  });

  test('the Tagreeve processes connected only to loopback addresses', async () => {
    const targets = (await readFile(connectLog, 'utf8')).split('\n').filter(Boolean);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter((t) => !/^(127\.0\.0\.1|localhost|::1|\[::1\])$/.test(t) && !t.startsWith('/'))).toEqual([]);
  });

  test('no record, stdout or stderr holds the access token, the config or the auth value', () => {
    expectNoSecrets(firstText + first.stdout + first.stderr);
    const capi = fromContainer(first.records!).find((r) => r.url.includes('graph.facebook.com'))!;
    expect(capi.url).toContain('access_token=[redacted]');
  });

  test('the fake email, its hash and its encoded form are in no record, stdout or stderr of a run that never sent them', () => {
    expect(firstText).toContain(createHash('sha256').update(IDENTITY_EMAIL).digest('hex'));
    expectNoEmail(firstText + first.stdout + first.stderr);
  });

  test('a second hit with an unrelated event ID is not linked, and a path no decoder knows still reaches the container', async () => {
    const before = site.sgtmRequests.length;
    const r = await run('server-container', ['--server-container', '--var', `email=${IDENTITY_EMAIL}`, '--var', 'extra=1'], env);
    const records = r.records!;
    expect(fromContainer(records)).toHaveLength(6);
    const capiHits = records.hits.filter((h) => h.vendor === 'meta-capi');
    expect(capiHits.map((h) => h.via?.confidence).sort()).toEqual(['exact', undefined]);
    expect(records.run.serverContainer!.unlinked).toBe(4);

    const data = records.requests.find((q) => new URL(q.url).pathname === '/data')!;
    expect(data.outcome).toBe('stubbed');
    expect(records.responses.find((s) => s.requestId === data.id)!.status).toBe(404);
    expect(site.sgtmRequests.slice(before)).toEqual([]);

    expect(JSON.stringify(records)).toContain(EMAIL_HASH);
    expect(r.failed).toContain('builtin: possibleRealData');
    expectNoEmail(r.stdout + r.stderr);
    expectNoSecrets(JSON.stringify(records) + r.stdout + r.stderr);
  }, 120_000);
});

describe('without --server-container', () => {
  test('the hit still goes to the pass-through host and no container is started', async () => {
    const before = site.sgtmRequests.length;
    const r = await run('server-container', ['--var', `email=${IDENTITY_EMAIL}`], env);
    expect(site.sgtmRequests.slice(before)).toContain('POST /capi');
    expect(r.records!.run.serverContainer).toBeUndefined();
    expect(r.records!.run.testServerContainer).toBeUndefined();
    expect(r.records!.requests.some((q) => q.captured === 'serverContainer')).toBe(false);
  }, 60_000);
});

describe('--server-container checks', () => {
  test('a scenario that is not in server mode exits 2 and starts no browser', async () => {
    const r = await run('accept', ['--server-container'], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--server-container needs --network server');
    expect(r.records).toBeUndefined();
  }, 60_000);

  test('--server-container-config without --server-container is a usage error', async () => {
    const r = await run('server-container', ['--server-container-config', '/nonexistent'], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--server-container-config needs --server-container');
  }, 60_000);

  test('a config file that others can read exits 2 before the browser starts, and the message holds no config', async () => {
    const config = join(outDir, 'config-open.txt');
    await writeFile(config, CONFIG);
    await chmod(config, 0o644);
    const r = await run('server-container', ['--server-container', '--server-container-config', config], { ...env, TAGREEVE_TEST_SERVER_CONTAINER_CMD: '', TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('mode 0600');
    expectNoSecrets(r.stdout + r.stderr);
  }, 60_000);

  test('a container that cannot start writes the run, sets the flag and exits 2', async () => {
    const empty = join(outDir, 'no-docker');
    await mkdir(empty, { recursive: true });
    const r = await run('server-container', ['--server-container'], { ...env, TAGREEVE_TEST_SERVER_CONTAINER_CMD: '', TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: '', PATH: empty });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Docker is needed');
    const path = /Record: (\S+)/.exec(r.stderr)?.[1];
    expect(path).toBeDefined();
    const text = await readFile(path!, 'utf8');
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { type: string; kind?: string; serverContainer?: { error?: string } });
    expect(lines[0]!.serverContainer!.error).toBe('dockerMissing');
    expect(lines.some((l) => l.type === 'flag' && l.kind === 'serverContainerFailed')).toBe(true);
    expectNoSecrets(text + r.stderr);
  }, 120_000);
});
