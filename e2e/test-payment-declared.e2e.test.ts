import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { readRun, type RunRecords } from '../packages/core/src/index.ts';
import { run, runCli, scenario, site, outDir } from './cli-helpers.ts';

const CARD = '4242424242424242';
const EMAIL = 'pw-fixture@example.com';
const SEAM = 'TAGREEVE_TEST_LOOPBACK_IS_HOSTED';
const DECLARATION = { host: 'localhost', testMode: 'fixture' };

async function config(hosts: unknown): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), 'pw-e2e-decl-'));
  await mkdir(join(root, 'tagreeve'));
  const file = join(root, 'tagreeve', 'test-payment-hosts.json');
  await writeFile(file, JSON.stringify(hosts));
  await chmod(file, 0o600);
  return { XDG_CONFIG_HOME: root, [SEAM]: '1' };
}

const allow = ['--allow-test-payment', 'localhost'];

beforeEach(() => {
  site.cardSubmits.length = 0;
});

test('a declared host types the card on a page that has card frames and no marker', async () => {
  const r = await run('test-payment-declared', allow, await config(['localhost', DECLARATION]));
  expect(r.code, r.stderr).toBe(0);
  expect(site.cardSubmits).toEqual([CARD]);
  expect(r.records!.steps.find((s) => s.payment)?.payment).toEqual({ provider: 'fixture', mode: 'test', testMode: 'declared' });
  expect(JSON.parse(r.stdout).testPayment).toEqual({ provider: 'fixture', host: 'localhost', testMode: 'declared' });
  expect(r.stderr + r.stdout).not.toContain(CARD);
}, 120_000);

test('the text summary says the test mode was declared', async () => {
  const r = await runCli(['run', scenario('test-payment-declared'), '--site', site.url, '--out', outDir, ...allow], await config([DECLARATION]));
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain('TEST PAYMENT: fixture on localhost (test mode declared)');
}, 120_000);

test('the same page without a declaration types nothing and the error says how to declare', async () => {
  const r = await run('test-payment-declared', allow, await config(['localhost']));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('test mode not detected');
  expect(r.stderr).toContain('{ "host": "localhost", "testMode": "fixture" }');
  expect(r.stderr).toContain('test-payment-hosts.json');
  expect(site.cardSubmits).toEqual([]);
  for (const value of [CARD, EMAIL, '12/40']) expect(r.stderr).not.toContain(value);
}, 120_000);

test('a declaration for another host does not apply to this one', async () => {
  const r = await run('test-payment-declared', allow, await config(['localhost', { host: 'other.example.com', testMode: 'shopify-test' }]));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('test mode not detected');
  expect(site.cardSubmits).toEqual([]);
}, 120_000);

test('a declaration is refused when the flag names another host', async () => {
  const r = await run('test-payment-declared', ['--allow-test-payment', '127.0.0.1'], await config([DECLARATION, '127.0.0.1']));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('must name the --site host');
  expect(site.cardSubmits).toEqual([]);
}, 60_000);

test('a declaration with a mistyped provider id is an error that names the file and the entry', async () => {
  const r = await run('test-payment-declared', allow, await config(['localhost', { host: 'localhost', testMode: 'fixtrue' }]));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('entry 1');
  expect(r.stderr).not.toContain('fixtrue');
  expect(site.cardSubmits).toEqual([]);
}, 60_000);

test('without the test seam the fixture declaration is refused', async () => {
  const env = await config([DECLARATION]);
  delete env[SEAM];
  const r = await run('test-payment-declared', allow, env);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('entry 0');
  expect(site.cardSubmits).toEqual([]);
}, 60_000);

const HASH = createHash('sha256').update(EMAIL).digest('hex');
const COOKIE_VALUE = 'pw-fixture-cookie-value';
const LEAKS = [EMAIL, encodeURIComponent(EMAIL), HASH, COOKIE_VALUE, CARD];

function requestUrls(records: RunRecords): string {
  return records.requests.map((r) => r.url).join('\n');
}

test('a declared run prints no email, hash or cookie value that the run recorded', async () => {
  const r = await run('test-payment-declared-leak', allow, await config(['localhost', DECLARATION]));
  expect(r.code, r.failed.join('; ')).toBe(0);
  const urls = requestUrls(r.records!);
  for (const value of [EMAIL, HASH, COOKIE_VALUE]) expect(urls).toContain(value);
  for (const value of LEAKS) {
    expect(r.stdout).not.toContain(value);
    expect(r.stderr).not.toContain(value);
  }
}, 120_000);

test('a run without a declaration prints no email, hash or cookie value either', async () => {
  const r = await run('test-payment-declared-leak', allow, await config(['localhost']));
  expect(r.code).toBe(2);
  expect(r.stdout).toBe('');
  expect(r.stderr).toContain('test mode not detected');
  const recordPath = /^Record: (.+)$/m.exec(r.stderr)?.[1];
  expect(recordPath).toBeDefined();
  const urls = requestUrls(await readRun(recordPath!));
  for (const value of [EMAIL, HASH, COOKIE_VALUE]) expect(urls).toContain(value);
  for (const value of LEAKS) expect(r.stderr).not.toContain(value);
  expect(site.cardSubmits).toEqual([]);
}, 120_000);
