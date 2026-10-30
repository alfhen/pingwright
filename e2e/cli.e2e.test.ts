import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type Hit, type RunRecords } from '../packages/core/src/index.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const rootVersion = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
const scenario = (name: string) => join(root, 'e2e/scenarios', `${name}.yml`);

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  execFileSync(process.execPath, [join(root, 'scripts/build.ts')], { cwd: root, stdio: 'inherit' });
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'cli-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  records: RunRecords | undefined;
  failed: string[];
}

function runCli(args: string[], env: Record<string, string> = {}): Promise<CliRun> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env } }, async (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      let records: RunRecords | undefined;
      let failed: string[] = [];
      try {
        const summary = JSON.parse(stdout) as { path: string; results: { expectation: string; pass: boolean }[] };
        records = await readRun(summary.path);
        failed = summary.results.filter((r) => !r.pass).map((r) => r.expectation);
      } catch {
        // Not a JSON summary: a usage or run error.
      }
      resolve({ code, stdout, stderr, records, failed });
    });
  });
}

const run = (name: string, extra: string[] = [], env: Record<string, string> = {}) =>
  runCli(['run', scenario(name), '--site', site.url, '--out', outDir, '--json', ...extra], env);

const ga4 = (hits: Hit[], event: string) => hits.filter((h) => h.vendor === 'ga4' && h.event === event);

// The fixture's sandboxed pixel sends its sandbox URL as the page, so this built-in check fails on every run of a page that has the pixel.
const SANDBOX = 'builtin: sandboxPageUrl';

test('undecided: hits per vendor, denied consent, flags, one epoch', async () => {
  const r = await run('undecided');
  expect(r.code).toBe(1);
  expect(r.failed).toEqual([SANDBOX]);
  const { hits, consentEpochs, flags, results } = r.records!;
  expect(results.length).toBeGreaterThan(0);
  expect(r.records!.run.recordSchemaVersion).toBe(1);
  expect(consentEpochs.map((e) => e.label)).toEqual(['undecided']);
  const ownConsent = ga4(hits, 'page_view').filter((h) => 'gcs' in h.consent.raw);
  expect(ownConsent.length).toBeGreaterThan(0);
  expect(ownConsent.every((h) => h.consent.analytics === 'denied')).toBe(true);
  expect(hits.some((h) => h.vendor === 'sgtm')).toBe(true);
  expect(hits.some((h) => h.vendor === 'meta' && h.event === 'PageView')).toBe(true);
  const stapeUrls = new Set(r.records!.requests.filter((q) => q.url.startsWith(`${site.sgtmUrl}/pwstape?`)).map((q) => q.id));
  expect(hits.some((h) => h.vendor === 'ga4' && stapeUrls.has(h.requestId))).toBe(true);
  expect(hits.some((h) => h.vendor === 'sgtm' && stapeUrls.has(h.requestId))).toBe(true);
  expect(flags.some((f) => f.kind === 'unknownDestination')).toBe(true);
  expect(flags.some((f) => f.kind === 'sandboxPageUrl')).toBe(true);
  expect(r.records!.requests.some((q) => q.outcome === 'stubbed')).toBe(true);
}, 90_000);

test('accept: granted epoch, add_to_cart granted', async () => {
  const r = await run('accept');
  expect(r.failed).toEqual([SANDBOX]);
  const { hits, consentEpochs } = r.records!;
  expect(consentEpochs.map((e) => e.label)).toEqual(['undecided', 'granted']);
  const atc = ga4(hits, 'add_to_cart');
  expect(atc.length).toBeGreaterThan(0);
  expect(atc.every((h) => h.consent.analytics === 'granted')).toBe(true);
  expect(hits.some((h) => h.vendor === 'meta' && h.event === 'AddToCart')).toBe(true);
}, 90_000);

test('reject: denied epoch, add_to_cart denied', async () => {
  const r = await run('reject');
  expect(r.failed).toEqual([SANDBOX]);
  expect(r.records!.consentEpochs.map((e) => e.label)).toEqual(['undecided', 'denied']);
  const atc = ga4(r.records!.hits, 'add_to_cart');
  expect(atc.length).toBeGreaterThan(0);
  expect(atc.every((h) => h.consent.analytics === 'denied')).toBe(true);
}, 90_000);

test('accept then withdraw: three epochs, add_to_cart denied', async () => {
  const r = await run('accept-then-withdraw');
  expect(r.failed).toEqual([SANDBOX]);
  expect(r.records!.consentEpochs.map((e) => e.label)).toEqual(['undecided', 'granted', 'withdrawn']);
  expect(r.records!.consentEpochs.at(-1)!.state.analytics).toBe('denied');
  const atc = ga4(r.records!.hits, 'add_to_cart');
  expect(atc.length).toBeGreaterThan(0);
  expect(atc.every((h) => h.consent.analytics === 'denied')).toBe(true);
}, 90_000);

test('a Meta hit after a withdrawal fails epoch(label=withdrawn) and epoch(denied)', async () => {
  for (const name of ['meta-after-withdrawn-label', 'meta-after-withdrawn-state']) {
    const r = await run(name);
    expect(r.code).toBe(1);
    const rule = r.records!.results.find((x) => x.expectation.startsWith('mustNot:'))!;
    expect(rule.pass).toBe(false);
    const meta = r.records!.hits.filter((h) => h.vendor === 'meta' && h.event === 'AddToCart');
    expect(meta.length).toBeGreaterThan(0);
    expect(rule.evidence).toEqual(expect.arrayContaining(meta.map((h) => h.id)));
  }
}, 180_000);

test('after a reject only, epoch(label=withdrawn) matches nothing', async () => {
  const r = await run('meta-reject-withdrawn-label');
  const rule = r.records!.results.find((x) => x.expectation.startsWith('mustNot:'))!;
  expect(rule.pass).toBe(true);
  expect(r.records!.hits.some((h) => h.vendor === 'meta')).toBe(true);
}, 90_000);

test('banner not shown: a HeadlessChrome user agent exits 2', async () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';
  const r = await run('banner-not-shown', [], { PINGWRIGHT_TEST_USER_AGENT: ua });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('banner not shown');
  expect(r.stderr).toContain('Record:');
}, 90_000);

test('banner not shown: the same scenario with the normal user agent gets past the consent step', async () => {
  const r = await run('banner-not-shown');
  expect(r.code).toBe(1);
  expect(r.failed).toEqual([SANDBOX]);
}, 90_000);

test('checkout after accept: purchase carries user_id with consent granted', async () => {
  const r = await run('checkout');
  expect(r.failed).toEqual([SANDBOX]);
  const purchase = ga4(r.records!.hits, 'purchase');
  expect(purchase.length).toBeGreaterThan(0);
  expect(purchase.every((h) => h.consent.analytics === 'granted' && h.ids.user_id)).toBe(true);
  expect(r.records!.hits.some((h) => h.vendor === 'meta' && h.event === 'Purchase')).toBe(true);
  expect(r.records!.hits.some((h) => h.vendor === 'google-ads')).toBe(true);
  expect(r.records!.run.identity).toMatchObject({ seed: 1 });
}, 120_000);

test('checkout after reject: the user_id mustNot rule fails and the run exits 1', async () => {
  const r = await run('checkout-reject');
  expect(r.code).toBe(1);
  const purchase = ga4(r.records!.hits, 'purchase');
  expect(purchase.length).toBeGreaterThan(0);
  expect(purchase.every((h) => h.consent.analytics === 'denied' && h.ids.user_id)).toBe(true);
  const rule = r.records!.results.find((x) => x.expectation.startsWith('mustNot:'))!;
  expect(rule.pass).toBe(false);
  expect(rule.evidence).toEqual(expect.arrayContaining(purchase.map((h) => h.id)));
}, 120_000);

test('checkout pattern: Meta Purchase carries the hashed email and hashesMatch passes', async () => {
  const r = await run('checkout-pattern');
  expect(r.failed).toEqual([SANDBOX]);
  const purchase = r.records!.hits.filter((h) => h.vendor === 'meta' && h.event === 'Purchase');
  expect(purchase.some((h) => h.params.hashedEmail)).toBe(true);
}, 120_000);

test('checkout pattern with a wrong email fails identity.hashesMatch', async () => {
  const r = await run('checkout-pattern-wrong-hash');
  expect(r.code).toBe(1);
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(rule.pass).toBe(false);
  expect(rule.message).toContain('do not match the run identity');
}, 120_000);

test('a mustNot meta before consent rule fails on the fixture pixel', async () => {
  const r = await run('meta-before-consent');
  expect(r.code).toBe(1);
  expect(r.failed).toContain('mustNot: {"vendor":"meta","before":"consent"}');
}, 90_000);

test('usage errors exit 2', async () => {
  expect((await runCli(['run'])).code).toBe(2);
  expect((await runCli(['run', scenario('undecided')])).stderr).toContain('--site is required');
  const undeclared = await runCli(['run', scenario('undecided'), '--site', site.url, '--var', 'nope=1']);
  expect(undeclared.code).toBe(2);
  expect(undeclared.stderr).toContain('not declared');
  expect((await runCli(['run', 'missing.yml', '--site', site.url])).code).toBe(2);
});

test('--version prints the root package version', async () => {
  const r = await runCli(['--version']);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(rootVersion);
});

const UNKNOWN = 'builtin: unknownDestination';

test('a third-party IP host is still an unknownDestination failure', async () => {
  const r = await run('third-party-ip');
  expect(r.failed).toContain(UNKNOWN);
  const { flags, requests } = r.records!;
  const hosts = flags
    .filter((f) => f.kind === 'unknownDestination')
    .map((f) => new URL(requests.find((q) => q.id === f.recordIds[0])!.url).hostname);
  expect(hosts).toContain('127.0.0.1');
  expect(flags.some((f) => f.kind === 'firstPartySubdomain')).toBe(false);
}, 90_000);

test('firstPartyHosts turns those requests into firstPartySubdomain flags that do not fail', async () => {
  const r = await run('first-party-hosts');
  expect(r.failed).not.toContain(UNKNOWN);
  const { flags } = r.records!;
  expect(flags.some((f) => f.kind === 'unknownDestination')).toBe(false);
  expect(flags.some((f) => f.kind === 'firstPartySubdomain' && f.detail.includes('/unknown-pixel'))).toBe(true);
}, 90_000);

test('run --help prints the help of run', async () => {
  const r = await runCli(['run', '--help']);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Usage: pingwright run <scenario.yml>');
});
