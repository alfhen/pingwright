import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, type FixtureSite } from '@tagreeve/fixture-site';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { launchRecorder } from '../../src/index.ts';
import { QUIET_MS } from '../../src/server-container/capture.ts';

const SEAM = 'TAGREEVE_TEST_SERVER_CONTAINER_CMD';
const CONFIG_ENV = 'TAGREEVE_SERVER_CONTAINER_CONFIG';
const LATE_HOST = 'late-collector.pw-fixture.invalid';
const saved = { seam: process.env[SEAM], config: process.env[CONFIG_ENV] };

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'server-container-'));
});

afterAll(async () => {
  for (const [name, value] of [[SEAM, saved.seam], [CONFIG_ENV, saved.config]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

async function standIn(name: string, body: string): Promise<string> {
  const file = join(outDir, name);
  await writeFile(file, `#!${process.execPath}\n${body}\n`);
  await chmod(file, 0o755);
  return file;
}

function launch() {
  process.env[CONFIG_ENV] = Buffer.from('id=GTM-PWTEST1&env=1&auth=pw-fixture-auth').toString('base64');
  return launchRecorder({
    networkMode: 'server',
    serverHosts: ['localhost'],
    outDir,
    site: site.url,
    serverContainer: { configSource: { kind: 'env' }, image: 'unused' },
  });
}

describe('the local server container', () => {
  test('the container gets the browser cookies of the server host, not those of its own address', async () => {
    const seen = join(outDir, 'cookies.log');
    process.env[SEAM] = await standIn(
      'cookie-stand-in',
      `import fs from 'node:fs';
import http from 'node:http';
http.createServer((req, res) => {
  if (req.url !== '/healthz') fs.appendFileSync(${JSON.stringify(seen)}, String(req.headers.cookie) + '\\n');
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    const recorder = await launch();
    try {
      await recorder.context.addCookies([{ name: 'FPID', value: 'pw-fixture-fpid', url: 'http://localhost/' }]);
      const page = await recorder.visit(`${site.url}/`);
      await page.evaluate(() => fetch('http://localhost:8080/g/collect?v=2', { mode: 'no-cors', credentials: 'include' }).catch(() => undefined));
      await recorder.wait(300);
    } finally {
      await recorder.close();
    }
    expect((await readFile(seen, 'utf8')).trim().split('\n')).toEqual(['FPID=pw-fixture-fpid']);
  }, 60_000);

  test('the container never touches the context cookie jar and gets no Cookie header when the browser sends none', async () => {
    const seen = join(outDir, 'jar.log');
    process.env[SEAM] = await standIn(
      'jar-stand-in',
      `import fs from 'node:fs';
import http from 'node:http';
http.createServer((req, res) => {
  if (req.url !== '/healthz') {
    fs.appendFileSync(${JSON.stringify(seen)}, String('cookie' in req.headers) + '\\n');
    res.setHeader('set-cookie', 'FPID=pw-fixture-fpid; Path=/');
  }
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    const recorder = await launch();
    let afterFirst: string[] = [];
    let jar: string[] = [];
    try {
      const page = await recorder.visit(`${site.url}/`);
      const call = () => page.evaluate(() => fetch('http://localhost:8080/g/collect?v=2', { mode: 'no-cors', credentials: 'include' }).catch(() => undefined));
      await call();
      await recorder.wait(300);
      afterFirst = (await recorder.context.cookies()).map((c) => c.domain);
      await recorder.context.clearCookies({ domain: 'localhost' });
      await call();
      await recorder.wait(300);
      jar = (await recorder.context.cookies()).map((c) => c.domain);
    } finally {
      await recorder.close();
    }
    expect(afterFirst).toContain('localhost');
    expect(jar).not.toContain('127.0.0.1');
    expect((await readFile(seen, 'utf8')).trim().split('\n')).toEqual(['false', 'false']);
  }, 60_000);

  test('concurrent container calls never pick up a cookie the container set on another call', async () => {
    const seen = join(outDir, 'burst.log');
    process.env[SEAM] = await standIn(
      'burst-stand-in',
      `import fs from 'node:fs';
import http from 'node:http';
http.createServer((req, res) => {
  if (req.url !== '/healthz') {
    fs.appendFileSync(${JSON.stringify(seen)}, String('cookie' in req.headers) + '\\n');
    res.setHeader('set-cookie', 'FPID=pw-fixture-fpid; Path=/');
  }
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    const recorder = await launch();
    try {
      const page = await recorder.visit(`${site.url}/`);
      await page.evaluate(() =>
        Promise.all(Array.from({ length: 30 }, (_, i) => fetch(`http://localhost:8080/g/collect?v=2&n=${i}`, { mode: 'no-cors' }).catch(() => undefined))),
      );
      await recorder.wait(300);
    } finally {
      await recorder.close();
    }
    const lines = (await readFile(seen, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(30);
    expect(lines.every((l) => l === 'false')).toBe(true);
  }, 60_000);

  test('a container call made after a handoff closes is redacted inside the grace window and kept after it', async () => {
    const signals = join(outDir, 'signals');
    await mkdir(signals, { recursive: true });
    process.env[SEAM] = await standIn(
      'late-stand-in',
      `import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
const proxy = new URL(process.env.HTTP_PROXY);
const host = ${JSON.stringify(LATE_HOST)};
function call(name) {
  const auth = Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
  const connect = http.request({ host: proxy.hostname, port: Number(proxy.port), method: 'CONNECT', path: host + ':443', headers: { 'Proxy-Authorization': 'Basic ' + auth } });
  connect.on('error', () => {});
  connect.on('connect', (response, socket) => {
    const secure = tls.connect({ socket, host, servername: host, ca: fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8') });
    secure.on('error', () => {});
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => secure;
    const body = 'email=pw-fixture%40example.test&name=' + name;
    const request = http.request({ agent, method: 'POST', host, path: '/submit?email=pw-fixture%40example.test&name=' + name, headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (res) => { res.resume(); res.on('end', () => secure.destroy()); });
    request.on('error', () => {});
    request.end(body);
  });
  connect.end();
}
http.createServer((req, res) => {
  res.end('ok');
  const name = new URL(req.url, 'http://x').searchParams.get('name');
  if (!name) return;
  const poll = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(signals)} + '/' + name)) { clearInterval(poll); call(name); }
  }, 20);
}).listen(Number(process.env.PORT), '127.0.0.1');`,
    );
    const recorder = await launch();
    let result: Awaited<ReturnType<typeof recorder.close>> | undefined;
    try {
      const page = await recorder.visit(`${site.url}/`);
      const submit = (name: string) =>
        page.evaluate(
          (n) => fetch(`http://localhost:8080/form?name=${n}`, { method: 'POST', body: 'email=pw-fixture%40example.test', mode: 'no-cors' }).catch(() => undefined),
          name,
        );
      const signal = (name: string) => writeFile(join(signals, name), '');
      recorder.setHandoff(true);
      await submit('inside');
      await recorder.wait(200);
      recorder.setHandoff(false);
      await signal('inside');
      await recorder.wait(400);
      await recorder.wait(QUIET_MS + 300);
      await submit('after');
      await signal('after');
      await recorder.wait(500);
    } finally {
      result = await recorder.close();
    }
    const requests = result.records.requests;
    const calls = requests.filter((r) => r.captured === 'serverContainer' && new URL(r.url).hostname === LATE_HOST).sort((a, b) => a.t - b.t);
    expect(requests.find((r) => r.url.includes('localhost:8080/form') && r.redacted === 'handoff')).toBeDefined();
    expect(calls).toHaveLength(2);
    const [inside, after] = calls;
    expect(inside).toMatchObject({ redacted: 'handoff', postData: '[redacted]' });
    expect(inside!.url).not.toContain('example.test');
    expect(after!.redacted).toBeUndefined();
    expect(after!.postData).toContain('email=pw-fixture%40example.test');
  }, 60_000);

  test('a container that ends during the run is recorded with its error and the serverContainerFailed flag', async () => {
    const ready = join(outDir, 'ready.log');
    process.env[SEAM] = await standIn(
      'exiting-stand-in',
      `import fs from 'node:fs';
import http from 'node:http';
http.createServer((req, res) => {
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready');
  res.end('ok');
}).listen(Number(process.env.PORT), '127.0.0.1');
setTimeout(() => process.exit(0), 800);`,
    );
    const recorder = await launch();
    await recorder.wait(1500);
    const { records: ended } = await recorder.close();
    expect(await readFile(ready, 'utf8')).toBe('ready');
    expect(ended.run.serverContainer?.error).toBe('exited');
    expect(ended.flags.map((f) => f.kind)).toContain('serverContainerFailed');
    expect(recorder.containerFailure?.errorClass).toBe('exited');
  }, 60_000);
});
