import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { standInContainerPath } from '../fixtures/site/src/index.ts';
import { DOCKERFILE } from '../packages/recorder/src/server-container/image.ts';
import { createFakeDocker } from '../packages/recorder/src/server-container/fake-docker.test-helper.ts';
import { createRunCa } from '../packages/recorder/src/server-container/ca.ts';
import type { RunCa } from '../packages/recorder/src/server-container/ca.ts';
import { createRecordingProxy } from '../packages/recorder/src/server-container/proxy.ts';
import type { ProxyRequest, RecordingProxy } from '../packages/recorder/src/server-container/proxy.ts';
import { startServerContainer } from '../packages/recorder/src/server-container/runner.ts';
import type { ServerContainer } from '../packages/recorder/src/server-container/runner.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const AUTH = 'pw-fixture-auth';
const ACCESS_TOKEN = 'pw-fixture-access-token';
const CONFIG = Buffer.from(`id=GTM-PWTEST1&env=1&auth=${AUTH}`).toString('base64');
const EMAIL = 'Pw.Runner@example.invalid';

let work: string;
let ca: RunCa;
let proxy: RecordingProxy;
let container: ServerContainer;
const dials: unknown[] = [];
const allowedPorts = new Set<number>();
let recordDials: () => void = () => {};
const answered: ProxyRequest[] = [];
const forwarded: ProxyRequest[] = [];

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'tagreeve-runner-e2e-'));
  ca = createRunCa(work);
  const connectSpy = vi.spyOn(net.Socket.prototype, 'connect');
  const tlsSpy = vi.spyOn(tls, 'connect');
  recordDials = () => {
    for (const call of connectSpy.mock.calls) {
      const raw = call[0] as unknown;
      const first = Array.isArray(raw) ? (raw[0] as unknown) : raw;
      const port = typeof first === 'object' && first !== null ? (first as { port?: number }).port : first;
      if (!allowedPorts.has(Number(port))) dials.push(first);
    }
    for (const call of tlsSpy.mock.calls) {
      if (!(call[0] as { socket?: unknown }).socket) dials.push(call[0]);
    }
  };
  proxy = await createRecordingProxy({
    host: '127.0.0.1',
    port: 0,
    ca,
    handler: (request) => {
      answered.push(request);
      return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"events_received":1}' };
    },
    forward: (request) => {
      forwarded.push(request);
      return { status: 200, body: '// fake file' };
    },
  });
  container = await startServerContainer({
    configSource: { kind: 'env' },
    proxyPort: proxy.port,
    proxyCredential: proxy.credential,
    proxyUsername: proxy.username,
    caPath: ca.certPath,
    image: 'tagreeve-sgtm:unused',
    serverHosts: ['127.0.0.1'],
    env: { PATH: process.env.PATH ?? '', TAGREEVE_TEST_SERVER_CONTAINER_CMD: standInContainerPath, TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG },
  });
  allowedPorts.add(proxy.port);
  allowedPorts.add(Number(new URL(container.origin).port));
});

afterAll(async () => {
  vi.restoreAllMocks();
  await container?.stop();
  await proxy?.close();
  ca?.close();
  rmSync(work, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
}

const where = (request: ProxyRequest) => `${request.method} ${new URL(request.url).host}${new URL(request.url).pathname}`;

describe('the stand-in server container through the seam', () => {
  test('makes the three vendor calls through the proxy, with decrypted bodies', async () => {
    const reply = await fetch(`${container.origin}/capi`, { method: 'POST', body: JSON.stringify({ event_name: 'Purchase', event_id: 'evt-runner-1', email: EMAIL }) });
    expect(reply.status).toBe(200);
    await until(() => answered.length >= 3);

    expect(answered.map(where)).toEqual([
      'POST www.google-analytics.com/g/collect',
      'GET www.googleadservices.com/pagead/conversion/000000001/',
      'POST graph.facebook.com/v21.0/100000000000001/events',
    ]);
    expect(answered[0]!.body.toString('utf8')).toContain('evt-runner-1');
    const capi = JSON.parse(answered[2]!.body.toString('utf8')) as { data: Array<{ event_name: string; event_id: string; user_data: { em: string[] } }> };
    expect(capi.data[0]).toMatchObject({ event_name: 'Purchase', event_id: 'evt-runner-1' });
    expect(capi.data[0]!.user_data.em).toEqual([createHash('sha256').update(EMAIL.toLowerCase()).digest('hex')]);
  });

  test('the two Google paths went to the forward function and nothing else did', () => {
    expect(forwarded.map((request) => new URL(request.url).pathname)).toEqual(['/server.js', '/s/gtag/destination']);
    expect(forwarded.every((request) => new URL(request.url).hostname === 'www.googletagmanager.com')).toBe(true);
    expect(answered.some((request) => new URL(request.url).hostname === 'www.googletagmanager.com')).toBe(false);
  });

  test('the test process dialled nothing but the proxy and the stand-in', () => {
    recordDials();
    expect(answered).toHaveLength(3);
    expect(dials).toEqual([]);
  });

  test('the proxy refused no one', () => {
    expect(proxy.refused()).toBe(0);
  });

  test('output and captured calls hold no config or gtm_auth, and the output no access token', () => {
    const output = container.logTail().join('\n');
    expect(output).toContain('www.googletagmanager.com');
    for (const secret of [CONFIG, AUTH, ACCESS_TOKEN]) expect(output).not.toContain(secret);
    const captured = JSON.stringify(answered.map((request) => ({ url: request.url, headers: request.headers, body: request.body.toString('utf8') })));
    for (const secret of [CONFIG, AUTH, proxy.credential]) expect(captured).not.toContain(secret);
  });
});

describe('tagreeve server-container build from a copy of dist/cli.js outside the repository', () => {
  const copy = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagreeve-dist-copy-'));
    cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
    copyFileSync(join(root, 'package.json'), join(dir, 'package.json'));
    symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
    return dir;
  };

  function run(dir: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(process.execPath, [join(dir, 'dist/cli.js'), 'server-container', 'build'], { cwd: dir, env }, (error, stdout, stderr) => {
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
  }

  test('writes the embedded Dockerfile into the build context, or says no build is needed', async () => {
    const dir = copy();
    const fake = createFakeDocker();
    try {
      const result = await run(dir, { ...fake.env(), PATH: `${fake.dir}:${process.env.PATH ?? ''}` });
      expect(result.code).toBe(0);
      const calls = fake.calls();
      if (process.arch === 'arm64') {
        expect(result.stdout).toContain('Built tagreeve-sgtm:');
        const build = calls.find((call) => call.argv[0] === 'build');
        expect(build?.dockerfile).toBe(DOCKERFILE);
        expect(build?.argv).toContain('linux/arm64');
      } else {
        expect(result.stdout).toContain('No build is needed');
        expect(calls.find((call) => call.argv[0] === 'build')).toBeUndefined();
      }
      expect(calls.some((call) => ['push', 'login'].includes(call.argv[0]!))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fake.dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.arch !== 'arm64')('exits 2 without docker', async () => {
    const dir = copy();
    const empty = mkdtempSync(join(tmpdir(), 'tagreeve-no-docker-'));
    try {
      mkdirSync(join(empty, 'bin'));
      const result = await run(dir, { PATH: join(empty, 'bin') });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('Docker is needed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
