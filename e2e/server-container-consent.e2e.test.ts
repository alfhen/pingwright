import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createIdentity, type Hit, type RunRecords } from '../packages/core/src/index.ts';
import { epochForHit } from '../packages/expect/src/index.ts';
import { standInContainerPath } from '../fixtures/site/src/index.ts';
import { outDir, root, run, type CliRun } from './cli-helpers.ts';

const ACCESS_TOKEN = 'pw-fixture-access-token';
const AUTH = 'pw-fixture-auth';
const CONFIG = Buffer.from(`id=GTM-PWTEST1&env=1&auth=${AUTH}`).toString('base64');
const IDENTITY_EMAIL = createIdentity(1).email;
const EMAIL_HASH = createHash('sha256').update(IDENTITY_EMAIL).digest('hex');
const OTHER_EMAIL = 'pw-fixture@example.com';
const OTHER_HASH = createHash('sha256').update(OTHER_EMAIL).digest('hex');
const COOKIE_NAME = 'pw_fixture_session';
const COOKIE_VALUE = 'pw-fixture-cookie-value';

let upstream: http.Server;
let env: Record<string, string>;

beforeAll(async () => {
  upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('// fake google file'));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  env = {
    TAGREEVE_TEST_SERVER_CONTAINER_CMD: standInContainerPath,
    TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG,
  };
});

afterAll(async () => {
  await new Promise((resolve) => upstream?.close(resolve));
});

function renderHtml(path: string, out: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), 'report', path, '--html', out], { cwd: root }, (error) => {
      resolve(error ? ((error as { code?: number }).code ?? 1) : 0);
    });
  });
}

interface Placed {
  pixel: Hit;
  capi: Hit;
  viaEpoch: string | undefined;
  ownEpoch: string | undefined;
}

function placeHits(records: RunRecords): Placed {
  const pixel = records.hits.find((h) => h.vendor === 'meta' && h.event === 'Purchase')!;
  const capi = records.hits.find((h) => h.vendor === 'meta-capi')!;
  const epochs = [...records.consentEpochs].sort((a, b) => a.startT - b.startT);
  return { pixel, capi, viaEpoch: epochForHit(epochs, pixel.t)?.label, ownEpoch: epochForHit(epochs, capi.t)?.label };
}

function expectFed(records: RunRecords, withOther: boolean): void {
  const raw = JSON.stringify(records);
  expect(raw).toContain(EMAIL_HASH);
  expect(raw).toContain(COOKIE_VALUE);
  expect(raw).toContain(IDENTITY_EMAIL);
  expect(raw).toContain(encodeURIComponent(IDENTITY_EMAIL));
  expect(records.checkpoints.flatMap((c) => c.cookies.map((k) => k.name))).toContain(COOKIE_NAME);
  expect(raw).toContain('access_token=[redacted]');
  expect(raw).not.toContain(ACCESS_TOKEN);
  if (withOther) {
    expect(raw).toContain(OTHER_EMAIL);
    expect(raw).toContain(OTHER_HASH);
  }
}

async function expectClean(r: CliRun, name: string, withOther = false): Promise<void> {
  expectFed(r.records!, withOther);
  const path = (JSON.parse(r.stdout) as { path: string }).path;
  const out = join(outDir, `${name}.html`);
  expect(await renderHtml(path, out)).toBe(0);
  const text = [r.stdout, r.stderr, await readFile(out, 'utf8')].join('\n');
  for (const secret of [ACCESS_TOKEN, CONFIG, AUTH, IDENTITY_EMAIL, EMAIL_HASH, encodeURIComponent(IDENTITY_EMAIL), OTHER_EMAIL, OTHER_HASH, COOKIE_VALUE]) expect(text).not.toContain(secret);
}

function summaryOf(r: CliRun): { serverContainer: Record<string, number>; results: { expectation: string; pass: boolean; severity: string; evidence: string[] }[] } {
  return JSON.parse(r.stdout) as ReturnType<typeof summaryOf>;
}

describe('a server hit is judged by the browser hit it came from', () => {
  let denied: CliRun;
  let late: CliRun;
  let extra: CliRun;

  beforeAll(async () => {
    denied = await run('server-container-denied', ['--server-container', '--var', `email=${IDENTITY_EMAIL}`], env);
    late = await run('server-container-late-accept', ['--server-container', '--var', `email=${IDENTITY_EMAIL}`], env);
    extra = await run('server-container-denied', ['--server-container', '--var', `email=${IDENTITY_EMAIL}`, '--var', 'extra=1'], env);
  }, 180_000);

  test('accept, send, withdraw: the hit sent in the denied epoch is linked to the granted one and passes', () => {
    const records = denied.records!;
    const { pixel, capi, viaEpoch, ownEpoch } = placeHits(records);
    expect(capi.via).toEqual({ hitId: pixel.id, by: 'eventId', confidence: 'exact' });
    expect(viaEpoch).toBe('granted');
    expect(ownEpoch).not.toBe(viaEpoch);
    expect(capi.idFields).toContain('user_data.em[]');
    const result = summaryOf(denied).results.find((r) => r.expectation === 'builtin: deniedIdentifiers')!;
    expect(result.pass).toBe(true);
    expect(denied.code).toBe(0);
  });

  test('reject, send, accept: the hit sent in the granted epoch is linked to the denied one and fails', () => {
    const records = late.records!;
    const { pixel, capi, viaEpoch, ownEpoch } = placeHits(records);
    expect(capi.via).toEqual({ hitId: pixel.id, by: 'eventId', confidence: 'exact' });
    expect(viaEpoch).toBe('denied');
    expect(ownEpoch).not.toBe(viaEpoch);
    const result = summaryOf(late).results.find((r) => r.expectation === 'builtin: deniedIdentifiers')!;
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('fail');
    expect(result.evidence).toContain(capi.id);
    expect(late.code).toBe(1);
  });

  test('the summary and --json count the vendor calls by link', () => {
    for (const r of [denied, late]) {
      expect(summaryOf(r).serverContainer).toMatchObject({ calls: 3, exact: 2, probable: 0, unlinked: 1, forwarded: 2 });
    }
  });

  test('the report shows the server vendors as their own rows, and no run leaks a secret or the identity', async () => {
    await expectClean(denied, 'server-container-denied');
    await expectClean(late, 'server-container-late-accept');
    await expectClean(extra, 'server-container-extra', true);
    const html = await readFile(join(outDir, 'server-container-late-accept.html'), 'utf8');
    expect(html).toContain('Meta Conversions API (meta-capi), sent by the server container');
  });
});
