import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScenario } from '../packages/expect/src/index.ts';
import { recordScenario, TEST_GTM_ORIGIN_ENV } from '../packages/recorder/src/index.ts';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'diff-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

async function record(override: boolean): Promise<string> {
  const parsed = parseScenario(await readFile(join(root, 'e2e/scenarios/gtm-direct.yml'), 'utf8'));
  process.env[TEST_GTM_ORIGIN_ENV] = site.containerUrl;
  try {
    const result = await recordScenario({
      networkMode: 'stub',
      outDir,
      site: site.url,
      scenario: 'gtm-direct.yml',
      parsed,
      firstPartyHosts: parsed.options.firstPartyHosts,
      gtmOverride: override ? { container: 'GTM-PWTEST1', gtmAuth: fakeWorkspace.gtm_auth, gtmPreview: fakeWorkspace.gtm_preview } : undefined,
    });
    return result.path;
  } finally {
    delete process.env[TEST_GTM_ORIGIN_ENV];
  }
}

function diff(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, 'diff', ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

test('diff shows the added workspace event, the removed Meta AddToCart and the gcs change, and exits 0', async () => {
  const published = await record(false);
  const workspace = await record(true);
  const r = await diff([published, workspace]);
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/Epoch undecided\n(?:.*\n)*? {2}ga4\n(?:.*\n)*? {4}workspace_only\n {6}added/);
  expect(r.stdout).toMatch(/ {2}meta\n {4}AddToCart\n {6}removed/);
  expect(r.stdout).toMatch(/ {4}page_view\n {6}changed.*: .*gcs \S+ -> \S+/);

  const json = JSON.parse((await diff([published, workspace, '--json'])).stdout) as {
    added: { key: { vendor: string; event: string; epoch: string } }[];
    removed: { key: { vendor: string; event: string } }[];
    changed: { key: { event: string; epoch: string }; consent: { field: string }[] }[];
  };
  expect(json.added.map((h) => `${h.key.vendor}/${h.key.event}`)).toContain('ga4/workspace_only');
  expect(json.removed.map((h) => `${h.key.vendor}/${h.key.event}`)).toContain('meta/AddToCart');
  const pageView = json.changed.find((c) => c.key.event === 'page_view');
  expect(pageView?.key.epoch).toBe('undecided');
  expect(pageView?.consent.map((c) => c.field)).toContain('gcs');
}, 120_000);

test('diff of a run with itself has no differences, and a missing file exits 2', async () => {
  const path = await record(false);
  const same = await diff([path, path]);
  expect(same.code).toBe(0);
  expect(same.stdout).toContain('No differences.');
  const missing = await diff([path, join(outDir, 'nope.jsonl')]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('nope.jsonl');
}, 120_000);

async function recordPlain(name: string): Promise<string> {
  const parsed = parseScenario(await readFile(join(root, `e2e/scenarios/${name}.yml`), 'utf8'));
  const result = await recordScenario({
    networkMode: 'stub',
    outDir,
    site: site.url,
    scenario: `${name}.yml`,
    parsed,
    firstPartyHosts: parsed.options.firstPartyHosts,
  });
  return result.path;
}

test('diff --by-page pairs sandboxed pixel hits across runs whose web-pixels hash differs', async () => {
  const a = await recordPlain('sandbox-hash-a');
  const b = await recordPlain('sandbox-hash-b');
  expect(await readFile(a, 'utf8')).toContain('/web-pixels@hasha1/sandbox/modern/');
  expect(await readFile(b, 'utf8')).toContain('/web-pixels@hashb2/sandbox/modern/');

  const json = JSON.parse((await diff([a, b, '--by-page', '--json'])).stdout) as Record<string, unknown[]>;
  expect(json).toMatchObject({ added: [], removed: [], changed: [], countMismatches: [] });
  expect((await diff([a, b, '--by-page'])).stdout).toContain('No differences.');
}, 120_000);

test('diff pairs a hit that lands in a different step in each run, and still reports a real change', async () => {
  const one = await recordPlain('delayed-hit-one-wait');
  const two = await recordPlain('delayed-hit-two-waits');
  const gcs = await recordPlain('delayed-hit-gcs');

  const same = await diff([one, two]);
  expect(same.code).toBe(0);
  expect(same.stdout).toContain('No differences.');
  const json = JSON.parse((await diff([one, two, '--json'])).stdout) as { added: unknown[]; removed: unknown[]; changed: unknown[] };
  expect(json).toMatchObject({ added: [], removed: [], changed: [] });

  const changed = await diff([one, gcs]);
  expect(changed.stdout).not.toMatch(/added|removed/);
  expect(changed.stdout).toMatch(/changed, step "wait-1" -> "wait-2": .*gcs G100 -> G111/);
}, 120_000);
