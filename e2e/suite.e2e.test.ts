import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun } from '../packages/core/src/index.ts';
import { diffRuns } from '../packages/expect/src/index.ts';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const auth = fakeWorkspace.gtm_auth;

interface Manifest {
  suiteSchemaVersion: number;
  site: string;
  variants: string[];
  cells: { scenario: string; variant: string; status: string; exitCode: number; record: string }[];
  diffs: { scenario: string; from: string; to: string; added: number }[];
  exitCode: number;
}

let site: FixtureSite;
let outDir: string;
let overridePath: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'suite-'));
  overridePath = join(await mkdtemp(join(parent, 'suite-override-')), 'workspace-override.json');
  await writeFile(overridePath, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: fakeWorkspace.gtm_preview }));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
  if (overridePath) await rm(join(overridePath, '..'), { recursive: true, force: true });
});

function suite(dir: string, out: string, json = true) {
  const args = ['suite', join(root, 'e2e/suites', dir), '--site', site.url, '--out', out, '--variant', 'published', '--variant', `workspace=${overridePath}`, ...(json ? ['--json'] : [])];
  const env = { ...process.env, PINGWRIGHT_TEST_GTM_ORIGIN: site.containerUrl };
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
}

const b64 = (s: string) => Buffer.from(s).toString('base64');
const forms = [auth, encodeURIComponent(auth), ...[0, 1, 2].map((k) => b64('A'.repeat(k) + auth).slice(4, -4))];

test('two scenarios by two variants: four cells, the workspace event as added, the same seed per scenario, exit 1 on a broken rule', async () => {
  const out = join(outDir, 'mixed');
  const r = await suite('mixed', out);
  expect(r.code, r.stderr).toBe(1);

  const manifest = JSON.parse(r.stdout) as Manifest;
  expect(manifest).toMatchObject({ suiteSchemaVersion: 1, variants: ['published', 'workspace'], exitCode: 1 });
  expect(manifest.site).toBe(new URL(site.url).origin);
  const status = (scenario: string, variant: string) => manifest.cells.find((c) => c.scenario === scenario && c.variant === variant)?.status;
  expect(manifest.cells).toHaveLength(4);
  expect(status('container-direct', 'published')).toBe('pass');
  expect(status('container-direct', 'workspace')).toBe('pass');
  expect(status('no-workspace-event', 'published')).toBe('pass');
  expect(status('no-workspace-event', 'workspace')).toBe('fail');

  expect(manifest.diffs.map((d) => `${d.scenario} ${d.from}->${d.to}`).sort()).toEqual(['container-direct published->workspace', 'no-workspace-event published->workspace']);
  expect(manifest.diffs.every((d) => d.added >= 1)).toBe(true);

  const [suiteDir] = await readdir(out);
  const dir = join(out, suiteDir!);
  for (const scenario of ['container-direct', 'no-workspace-event']) {
    const published = await readRun(join(dir, `${scenario}.published.jsonl`));
    const workspace = await readRun(join(dir, `${scenario}.workspace.jsonl`));
    expect(published.run.variant).toBe('published');
    expect(workspace.run.variant).toBe('workspace');
    expect(published.run.identitySeed).toBeTypeOf('number');
    expect(workspace.run.identitySeed).toBe(published.run.identitySeed);
    const diff = diffRuns(published, workspace);
    expect(diff.added.map((h) => h.key.event)).toContain('workspace_only');
  }

  for (const file of await files(out)) {
    const text = await readFile(file, 'utf8');
    for (const form of forms) expect(text, `${file} holds ${form}`).not.toContain(form);
    expect(text, file).not.toContain(overridePath);
  }
  for (const form of forms) {
    expect(r.stdout).not.toContain(form);
    expect(r.stderr).not.toContain(form);
  }
  expect(r.stderr).not.toContain(overridePath);
}, 300_000);

test('the table prints a header and one row per scenario with a status per variant', async () => {
  const r = await suite('mixed', join(outDir, 'table'), false);
  expect(r.code, r.stderr).toBe(1);
  const lines = r.stdout.split('\n');
  expect(lines.find((l) => /^scenario\s+published\s+workspace/.test(l)), r.stdout).toBeDefined();
  expect(lines.find((l) => l.startsWith('container-direct'))).toMatch(/^container-direct\s+PASS\s+PASS\s+\+\d+ added/);
  expect(lines.find((l) => l.startsWith('no-workspace-event'))).toMatch(/^no-workspace-event\s+PASS\s+FAIL\s+\+\d+ added/);
  expect(r.stdout).toContain('diff (published -> workspace)');
  for (const form of forms) expect(r.stdout + r.stderr).not.toContain(form);
}, 300_000);

test('the exit code is 0 when no rule breaks', async () => {
  const out = join(outDir, 'clean');
  const r = await suite('clean', out, false);
  expect(r.code, r.stderr).toBe(0);
  const [suiteDir] = await readdir(out);
  const manifest = JSON.parse(await readFile(join(out, suiteDir!, 'suite.json'), 'utf8')) as Manifest;
  expect(manifest.cells).toHaveLength(2);
  expect(manifest.exitCode).toBe(0);
  for (const form of forms) expect(r.stdout + r.stderr).not.toContain(form);
}, 300_000);
