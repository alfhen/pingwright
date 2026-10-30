import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type Hit, type RunRecords } from '../packages/core/src/index.ts';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const scenario = (name: string) => join(root, 'e2e/scenarios', `${name}.yml`);
const auth = fakeWorkspace.gtm_auth;

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'gtm-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  path: string | undefined;
  records: RunRecords | undefined;
}

async function overrideFile(extra: Record<string, unknown> = {}): Promise<string> {
  const path = join(outDir, `override-${Math.random().toString(36).slice(2)}.json`);
  const body = { container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: fakeWorkspace.gtm_preview, ...extra };
  await writeFile(path, JSON.stringify(body));
  return path;
}

function runCli(name: string, extra: string[], env: Record<string, string>): Promise<CliRun> {
  const args = ['run', scenario(name), '--site', site.url, '--out', outDir, '--json', ...extra];
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env: { ...process.env, ...env } }, async (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      let path: string | undefined;
      try {
        path = (JSON.parse(stdout) as { path: string }).path;
      } catch {
        path = /^Record: (.+)$/m.exec(stderr)?.[1];
      }
      resolve({ code, stdout, stderr, path, records: path ? await readRun(path) : undefined });
    });
  });
}

const testOrigin = () => ({ PINGWRIGHT_TEST_GTM_ORIGIN: site.containerUrl });
const ga4 = (hits: Hit[], event: string) => hits.filter((h) => h.vendor === 'ga4' && h.event === event);
const meta = (hits: Hit[], event: string) => hits.filter((h) => h.vendor === 'meta' && h.event === event);

const b64 = (s: string) => Buffer.from(s).toString('base64');
// The middle of the base64 text does not depend on what precedes the value, so each alignment is covered.
const forms = [auth, encodeURIComponent(auth), ...[0, 1, 2].map((k) => b64('A'.repeat(k) + auth).slice(4, -4))];

test('without an override the published build runs, and the test origin is recorded and warned about', async () => {
  const r = await runCli('gtm-direct', [], testOrigin());
  expect(r.code).not.toBe(2);
  const { run, hits } = r.records!;
  expect(run.gtmOverride).toBeNull();
  expect(run.testGtmOrigin).toBe(site.containerUrl);
  expect(r.stderr).toContain('PINGWRIGHT_TEST_GTM_ORIGIN');
  expect(ga4(hits, 'container_event').length).toBeGreaterThan(0);
  expect(ga4(hits, 'workspace_only')).toEqual([]);
  expect(meta(hits, 'AddToCart').length).toBeGreaterThan(0);
}, 90_000);

test('with an override the workspace build runs and the match is recorded without the auth', async () => {
  site.receivedGtmAuth.length = 0;
  const r = await runCli('gtm-direct', ['--gtm-override', await overrideFile({ expectedTags: [{ id: '45', name: 'GA4 - Purchase' }] })], testOrigin());
  expect(r.code).not.toBe(2);
  const { run, hits, requests } = r.records!;
  expect(run.gtmOverride).toEqual({
    container: 'GTM-PWTEST1',
    gtmPreview: 'env-99',
    gtmAuth: '[redacted]',
    expectedTags: [{ id: '45', name: 'GA4 - Purchase' }],
    applied: [{ way: 'direct', url: 'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1', status: 200 }],
  });
  expect(run.testGtmOrigin).toBe(site.containerUrl);
  expect(ga4(hits, 'workspace_only').length).toBeGreaterThan(0);
  expect(meta(hits, 'AddToCart')).toEqual([]);
  expect(requests.filter((q) => q.url.startsWith('https://www.googletagmanager.com/gtm.js')).map((q) => q.url)).toEqual([
    'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1',
  ]);
  // Positive control: the container host did receive the value, so the scrub below has something to remove.
  expect(site.receivedGtmAuth).toContain(auth);
}, 90_000);

test('the echo page leaks the value in nested forms and none of it reaches the record or the output', async () => {
  const r = await runCli('gtm-echo', ['--gtm-override', await overrideFile()], testOrigin());
  expect(r.code).not.toBe(2);
  const text = await readFile(r.path!, 'utf8');
  for (const form of forms) {
    expect(text, form).not.toContain(form);
    expect(r.stdout, form).not.toContain(form);
    expect(r.stderr, form).not.toContain(form);
  }

  // Independent of the scrub's decoder: the raw lines, parsed as plain JSON.
  const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { type: string; url?: string; headers?: Record<string, string>; postData?: string | null });
  const requests = lines.filter((l) => l.type === 'request');
  const stape = requests.filter((q) => new URL(q.url!).origin === site.sgtmUrl && new URL(q.url!).pathname === '/pwstape');
  const loaderPaths = stape.map((q) => new URL(q.url!).searchParams.get('pk'));
  expect(loaderPaths.length).toBeGreaterThanOrEqual(2);
  for (const q of stape) {
    for (const [, value] of new URL(q.url!).searchParams) expect(value).toBe('[redacted]');
  }
  const third = requests.filter((q) => new URL(q.url!).origin === site.thirdPartyUrl);
  expect(third.find((q) => q.url!.includes('/gtm-echo.gif'))!.url).toContain('gtm_auth=[redacted]');
  expect(third.find((q) => q.url!.includes('/gtm-echo') && q.postData)!.postData).toBe('gtm_auth=[redacted]');
  expect(third.find((q) => q.url!.includes('/gtm-referer.gif'))!.headers!['referer']).toBe('[redacted]');

  const { hits } = r.records!;
  expect(ga4(hits, 'ws_echo').some((h) => h.page === '[redacted]')).toBe(true);
  expect(hits.some((h) => h.vendor === 'sgtm' && h.page === '[redacted]')).toBe(true);
}, 90_000);

test('a loader request from a page that never held the value keeps its pk and its hit', async () => {
  const r = await runCli('gtm-no-container', ['--gtm-override', await overrideFile()], testOrigin());
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('no container request matched');
  expect(r.path, 'the JSONL is still written').toBeDefined();
  const { run, requests, hits } = r.records!;
  expect(run.gtmOverride!.applied).toEqual([]);
  const pk = requests.filter((q) => q.url.startsWith(`${site.sgtmUrl}/pwstape?`)).map((q) => new URL(q.url).searchParams.get('pk'));
  expect(pk.length).toBeGreaterThan(0);
  expect(pk.every((v) => v !== null && v !== '[redacted]')).toBe(true);
  expect(hits.some((h) => h.vendor === 'sgtm')).toBe(true);
  expect(hits.some((h) => h.vendor === 'ga4' && h.transport.includes('stape-loader'))).toBe(true);
}, 90_000);

test('a container with no version fails with the 404 message and still writes the record', async () => {
  const r = await runCli('gtm-noversion', ['--gtm-override', await overrideFile({ container: 'GTM-PWNOVER' })], testOrigin());
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('returned status 404');
  expect(r.stderr).toContain('may have no version');
  expect(r.records!.run.gtmOverride!.applied).toEqual([
    { way: 'direct', url: 'https://www.googletagmanager.com/gtm.js?id=GTM-PWNOVER', status: 404 },
  ]);
  expect(r.stderr).not.toContain(auth);
}, 90_000);

test('a test origin that is not loopback is a hard error', async () => {
  for (const origin of ['http://127.0.0.1.example.com', 'https://127.0.0.1:4000', 'http://example.com']) {
    const r = await runCli('gtm-direct', [], { PINGWRIGHT_TEST_GTM_ORIGIN: origin });
    expect(r.code, origin).toBe(2);
    expect(r.stderr).toContain('PINGWRIGHT_TEST_GTM_ORIGIN must be');
    expect(r.path).toBeUndefined();
  }
});

test('a bad override file exits 2 without repeating its content', async () => {
  const bad = join(outDir, 'bad.json');
  await writeFile(bad, `{"container": "GTM-PWTEST1", "gtmAuth": "${auth}", oops`);
  const unparsable = await runCli('gtm-direct', ['--gtm-override', bad], testOrigin());
  expect(unparsable.code).toBe(2);
  expect(unparsable.stderr).toContain('is not valid JSON');
  expect(unparsable.stderr).not.toContain(auth);
  const invalid = await runCli('gtm-direct', ['--gtm-override', await overrideFile({ container: 'gtm-lower' })], testOrigin());
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain('container must');
  expect(invalid.stderr).not.toContain(auth);
});

async function expectNoAuth(r: CliRun): Promise<void> {
  const text = await readFile(r.path!, 'utf8');
  for (const form of forms) {
    expect(text, form).not.toContain(form);
    expect(r.stdout, form).not.toContain(form);
    expect(r.stderr, form).not.toContain(form);
  }
}

const loaderUrl = () => `${site.sgtmUrl}/pwstape?pk=${encodeURIComponent(b64('/gtm.js?id=GTM-PWTEST1'))}`;

test.each([
  ['the page', 'gtm-loader'],
  ['a sandboxed iframe', 'gtm-loader-sandbox'],
])('a Stape-style loader in %s serves the workspace build and is recorded as way loader', async (_name, scenarioName) => {
  site.receivedGtmAuth.length = 0;
  const r = await runCli(scenarioName, ['--gtm-override', await overrideFile()], testOrigin());
  expect(r.code).not.toBe(2);
  const { run, hits, requests } = r.records!;
  expect(run.gtmOverride!.applied).toEqual([
    { way: 'loader', loader: 'stape', url: loaderUrl(), status: 200, loses: 'nothing known; the loader script runs unchanged' },
  ]);
  expect(ga4(hits, 'workspace_only').length).toBeGreaterThan(0);
  expect(meta(hits, 'AddToCart')).toEqual([]);
  expect(requests.some((q) => q.url === loaderUrl())).toBe(true);
  expect(site.receivedGtmAuth).toContain(auth);
  await expectNoAuth(r);
}, 90_000);

test('the sandboxed iframe loader runs the published build without an override', async () => {
  const r = await runCli('gtm-loader-sandbox', [], testOrigin());
  expect(r.code).not.toBe(2);
  expect(ga4(r.records!.hits, 'container_event').length).toBeGreaterThan(0);
  expect(ga4(r.records!.hits, 'workspace_only')).toEqual([]);
}, 90_000);

test('loader.replace swaps the loader script for the workspace build and records way replace', async () => {
  const r = await runCli('gtm-loader', ['--gtm-override', await overrideFile({ loader: { replace: loaderUrl() } })], testOrigin());
  expect(r.code).not.toBe(2);
  const { run, hits } = r.records!;
  expect(run.gtmOverride!.applied).toEqual([
    { way: 'replace', url: loaderUrl(), status: 200, loses: 'everything the loader does beyond fetching the container' },
  ]);
  expect(ga4(hits, 'workspace_only').length).toBeGreaterThan(0);
  await expectNoAuth(r);
}, 90_000);

const scriptLoaderUrl = () => `${site.sgtmUrl}/pwload-a1b2c3.js?k=${encodeURIComponent([...'/gtm.js?id=GTM-PWTEST1'].reverse().join(''))}`;

test.each([
  ['the page', 'gtm-loader-script'],
  ['a sandboxed iframe', 'gtm-loader-script-sandbox'],
])('a Stape loader script URL in %s is found by its body and serves the workspace build', async (_name, scenarioName) => {
  site.receivedGtmAuth.length = 0;
  const r = await runCli(scenarioName, ['--gtm-override', await overrideFile()], testOrigin());
  expect(r.code).not.toBe(2);
  const { run, hits } = r.records!;
  expect(run.gtmOverride!.applied).toEqual([
    { way: 'loader', loader: 'stape', url: scriptLoaderUrl(), status: 200, loses: 'everything the loader does beyond fetching the container' },
  ]);
  expect(ga4(hits, 'workspace_only').length).toBeGreaterThan(0);
  expect(meta(hits, 'AddToCart')).toEqual([]);
  expect(site.receivedGtmAuth).toContain(auth);
  await expectNoAuth(r);
}, 90_000);

test('a Stape loader script runs the published build without an override', async () => {
  const r = await runCli('gtm-loader-script', [], testOrigin());
  expect(r.code).not.toBe(2);
  expect(ga4(r.records!.hits, 'container_event').length).toBeGreaterThan(0);
  expect(ga4(r.records!.hits, 'workspace_only')).toEqual([]);
}, 90_000);

test('loader.match swaps any script URL that matches the regex and records way replace', async () => {
  const r = await runCli('gtm-loader-script', ['--gtm-override', await overrideFile({ loader: { match: '/pwload-[a-z0-9]+\\.js\\?' } })], testOrigin());
  expect(r.code).not.toBe(2);
  const { run, hits } = r.records!;
  expect(run.gtmOverride!.applied).toEqual([
    { way: 'replace', url: scriptLoaderUrl(), status: 200, loses: 'everything the loader does beyond fetching the container' },
  ]);
  expect(ga4(hits, 'workspace_only').length).toBeGreaterThan(0);
  await expectNoAuth(r);
}, 90_000);

test('a loader script for another container exits 2 and the message lists the script without query values', async () => {
  const r = await runCli('gtm-loader-script', ['--gtm-override', await overrideFile({ container: 'GTM-PWOTHER1', loader: { match: 'does-not-match-anything' } })], testOrigin());
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('no container request matched');
  expect(r.stderr).toContain(`${site.sgtmUrl}/pwload-a1b2c3.js?k=…`);
  expect(r.stderr).toContain('"loader": {"replace"');
  expect(r.stderr).not.toContain(encodeURIComponent([...'/gtm.js?id=GTM-PWTEST1'].reverse().join('')));
  expect(r.records!.run.gtmOverride!.applied).toEqual([]);
  await expectNoAuth(r);
}, 90_000);

test('a container ID that is a prefix of the loader script container does not match its body', async () => {
  const r = await runCli('gtm-loader-script', ['--gtm-override', await overrideFile({ container: 'GTM-PWTEST' })], testOrigin());
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('no container request matched');
  expect(r.records!.run.gtmOverride!.applied).toEqual([]);
  await expectNoAuth(r);
}, 90_000);

test('a cross-origin script that redirects to a collection endpoint is not hidden by the loader sniff', async () => {
  const r = await runCli('gtm-redirect-script', ['--gtm-override', await overrideFile()], testOrigin());
  const { requests, flags } = r.records!;
  const hop = requests.find((q) => q.url?.startsWith(`${site.sgtmUrl}/g/collect`));
  expect(hop).toBeDefined();
  const flagged = flags.some((f) => f.kind === 'stubBypass' && f.recordIds.includes(hop!.id));
  expect(hop!.outcome === 'stubbed' || flagged).toBe(true);
  await expectNoAuth(r);
}, 90_000);
