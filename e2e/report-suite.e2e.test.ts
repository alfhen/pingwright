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
const auth = fakeWorkspace.gtm_auth;

let site: FixtureSite;
let outDir: string;
let suiteDir: string;
let html: string;
let overridePath: string;
let idSuiteDir: string;
let idHtml: string;

function node(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'report-suite-'));
  overridePath = join(outDir, 'workspace-override.json');
  await writeFile(overridePath, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: fakeWorkspace.gtm_preview }));
  const out = join(outDir, 'runs');
  const suite = await node(
    ['suite', join(root, 'e2e/suites/mixed'), '--site', site.url, '--out', out, '--variant', 'published', '--variant', `workspace=${overridePath}`],
    { ...process.env, PINGWRIGHT_TEST_GTM_ORIGIN: site.containerUrl },
  );
  expect(suite.code, suite.stderr).toBe(1);
  const [name] = await readdir(out);
  suiteDir = join(out, name!);
  const page = join(outDir, 'suite.html');
  const report = await node(['report', suiteDir, '--html', page]);
  expect(report.code, report.stderr).toBe(0);
  html = await readFile(page, 'utf8');

  const idOut = join(outDir, 'id-runs');
  const idSuite = await node(['suite', join(root, 'e2e/suites/identifiers'), '--site', site.url, '--out', idOut]);
  expect(idSuite.code, idSuite.stderr).toBe(0);
  const [idName] = await readdir(idOut);
  idSuiteDir = join(idOut, idName!);
  const idPage = join(outDir, 'suite-identifiers.html');
  const idReport = await node(['report', idSuiteDir, '--html', idPage]);
  expect(idReport.code, idReport.stderr).toBe(0);
  idHtml = await readFile(idPage, 'utf8');
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('the suite page lists both variants and both scenarios', () => {
  expect(html).toContain('<th scope="col">published</th><th scope="col">workspace</th>');
  expect(html).toContain('<h2>container-direct</h2>');
  expect(html).toContain('<h2>no-workspace-event</h2>');
  expect(html).toMatch(/no-workspace-event<\/th><td>PASS<\/td><td>FAIL: 1 rule<\/td>/);
});

test('the diff section shows workspace_only as added', () => {
  const section = html.slice(html.indexOf('<h2>Diff per variant pair</h2>'));
  expect(section).not.toContain('No differences.');
  expect(section).not.toContain('No variant pair has two records');
  const rows = [...section.matchAll(/<tr><td>[^<]*<\/td><td>[^<]*<\/td><td>workspace_only<\/td><td>(\d+)<\/td>/g)];
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) expect(Number(row[1])).toBeGreaterThanOrEqual(1);
});

test('the page holds no run identity and no hash of it', async () => {
  const files = (await readdir(suiteDir)).filter((f) => f.endsWith('.jsonl'));
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const file of files) {
    const { identity } = (await readRun(join(suiteDir, file))).run;
    expect(identity, file).not.toBeNull();
    const hash = createHash('sha256').update(identity!.email.trim().toLowerCase()).digest('hex');
    expect(html).not.toContain(identity!.email);
    expect(html).not.toContain(hash);
  }
  expect(html).not.toContain('pw-fixture@example.com');
});

test('a suite page of hits that carry the hashed email holds neither the email nor its hash', async () => {
  const [file] = (await readdir(idSuiteDir)).filter((f) => f.endsWith('.jsonl'));
  const records = await readRun(join(idSuiteDir, file!));
  const { identity } = records.run;
  const hash = createHash('sha256').update(identity!.email.trim().toLowerCase()).digest('hex');
  const carrying = records.requests.filter((q) => q.url.includes(hash) || (q.postData ?? '').includes(hash));
  expect(carrying.length, 'no request carries the hashed email, so this check proves nothing').toBeGreaterThan(0);
  expect(records.hits.length).toBeGreaterThan(0);
  expect(idHtml).toContain('<h2>identifiers</h2>');
  expect(idHtml).not.toContain(identity!.email);
  expect(idHtml).not.toContain(hash);
});

test('the page holds no value and makes no request', () => {
  for (const secret of [auth, encodeURIComponent(auth), overridePath, site.url, fakeWorkspace.gtm_preview]) expect(html).not.toContain(secret);
  expect(html).toContain('Content-Security-Policy');
  expect(html).not.toMatch(/<script|<link|<img|url\(|@import/i);
  expect((html.match(/<[^>]*>/g) ?? []).join('\n')).not.toMatch(/https?:/i);
});
