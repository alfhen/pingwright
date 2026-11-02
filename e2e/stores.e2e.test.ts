import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun } from '../packages/core/src/index.ts';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');

interface Manifest {
  suiteSchemaVersion: number;
  site: string;
  stores: { name: string; site: string }[];
  cells: { scenario: string; variant: string; labels: Record<string, string>; status: string; record?: string }[];
  diffs: { scenario: string; store?: string; from: string; to: string }[];
}

let site: FixtureSite;
let outDir: string;
let suiteDir: string;
let table: string;
let manifestText: string;
let manifest: Manifest;
let html: string;
let usage: { code: number; stderr: string };

function node(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  site = await startFixtureSite();
  const port = new URL(site.url).port;
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'stores-'));
  const stores = join(outDir, 'stores.json');
  await writeFile(
    stores,
    JSON.stringify({
      storesSchemaVersion: 1,
      stores: [
        { name: 'a', site: `http://localhost:${port}` },
        { name: 'b', site: `http://127.0.0.1:${port}`, country: 'SE' },
      ],
    }),
  );
  const override = join(outDir, 'override.json');
  await writeFile(override, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: fakeWorkspace.gtm_auth, gtmPreview: fakeWorkspace.gtm_preview }));
  const out = join(outDir, 'runs');
  const suite = await node(['suite', join(root, 'e2e/suites/stores'), '--stores', stores, '--out', out, '--variant', 'published', '--variant', `workspace=${override}`], {
    ...process.env,
    TAGREEVE_TEST_GTM_ORIGIN: site.containerUrl,
  });
  expect(suite.code, suite.stderr).toBe(0);
  table = suite.stdout;
  const [name] = await readdir(out);
  suiteDir = join(out, name!);
  manifestText = await readFile(join(suiteDir, 'suite.json'), 'utf8');
  manifest = JSON.parse(manifestText) as Manifest;
  const page = join(outDir, 'suite.html');
  const report = await node(['report', suiteDir, '--html', page]);
  expect(report.code, report.stderr).toBe(0);
  html = await readFile(page, 'utf8');
  const both = await node(['suite', join(root, 'e2e/suites/stores'), '--stores', stores, '--site', site.url, '--out', out]);
  usage = { code: both.code, stderr: both.stderr };
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('two scenarios on two stores and two variants make eight cells labelled with the store', () => {
  expect(manifest.suiteSchemaVersion).toBe(2);
  expect(manifest.stores.map((s) => s.name)).toEqual(['a', 'b']);
  expect(manifest.cells).toHaveLength(8);
  for (const scenario of ['first', 'second']) {
    for (const store of ['a', 'b']) {
      const cells = manifest.cells.filter((c) => c.scenario === scenario && c.labels.store === store);
      expect(cells.map((c) => [c.variant, c.status, c.record])).toEqual([
        ['published', 'pass', `${scenario}.${store}.published.jsonl`],
        ['workspace', 'pass', `${scenario}.${store}.workspace.jsonl`],
      ]);
    }
  }
});

test('store b has country SE in its runs and store a does not', async () => {
  const b = await readRun(join(suiteDir, 'first.b.published.jsonl'));
  const a = await readRun(join(suiteDir, 'first.a.published.jsonl'));
  expect(b.run.identity?.country).toBe('SE');
  expect(a.run.identity?.country).not.toBe('SE');
  expect(new URL(b.run.site).hostname).toBe('127.0.0.1');
  expect(new URL(a.run.site).hostname).toBe('localhost');
});

test('diffs compare variants within one store only', () => {
  expect(manifest.diffs.map((d) => [d.scenario, d.store, d.from, d.to]).sort()).toEqual(
    [
      ['first', 'a', 'published', 'workspace'],
      ['first', 'b', 'published', 'workspace'],
      ['second', 'a', 'published', 'workspace'],
      ['second', 'b', 'published', 'workspace'],
    ].sort(),
  );
});

test('the table and the report have one row per scenario and store', () => {
  expect(table).toMatch(/^scenario\s+store\s+published\s+workspace\s+diff \(published -> workspace\)$/m);
  for (const scenario of ['first', 'second']) {
    for (const store of ['a', 'b']) {
      expect(table).toMatch(new RegExp(`^${scenario}\\s+${store}\\s+PASS\\s+PASS\\s`, 'm'));
      expect(html).toContain(`<tr><th scope="row">${scenario}</th><td>${store}</td><td>PASS</td><td>PASS</td></tr>`);
    }
  }
  expect(html).toContain('<h3>first on b, workspace: PASS</h3>');
  expect(html).toContain('<li><strong>a, published:</strong>');
  expect(html).toContain('<li><strong>b, workspace:</strong>');
});

test('the manifest and the report hold no email, hash or path', async () => {
  const email = (await readRun(join(suiteDir, 'first.a.published.jsonl'))).run.identity!.email;
  const hash = createHash('sha256').update(email).digest('hex');
  const records = (await Promise.all((await readdir(suiteDir)).filter((f) => f.endsWith('.jsonl')).map((f) => readFile(join(suiteDir, f), 'utf8')))).join('\n');
  expect(records, 'positive control: the records carry the email').toContain(email);
  for (const text of [manifestText, html, table]) {
    for (const secret of [email, hash, '/container/direct']) expect(text).not.toContain(secret);
  }
});

test('--stores with --site is a usage error', () => {
  expect(usage.code).toBe(2);
  expect(usage.stderr).toContain('--site and --stores cannot be used together');
});
