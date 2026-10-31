import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const auth = fakeWorkspace.gtm_auth;

let site: FixtureSite;
let outDir: string;
let html: string;
let overridePath: string;

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
  const suiteDir = join(out, name!);
  const page = join(outDir, 'suite.html');
  const report = await node(['report', suiteDir, '--html', page]);
  expect(report.code, report.stderr).toBe(0);
  html = await readFile(page, 'utf8');
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('the suite page lists both variants and both scenarios', () => {
  expect(html).toContain('<th scope="col">published</th><th scope="col">workspace</th>');
  expect(html).toContain('<h2>container-direct</h2>');
  expect(html).toContain('<h2>no-workspace-event</h2>');
  expect(html).toMatch(/no-workspace-event<\/th><td>PASS \(exit 0\)<\/td><td>FAIL \(exit 1\)<\/td>/);
});

test('the diff section shows workspace_only as added', () => {
  const section = html.slice(html.indexOf('<h2>Diff per variant pair</h2>'), html.indexOf('<section>'));
  expect(section).not.toContain('No differences.');
  expect(section).not.toContain('No variant pair has two records');
  const rows = [...section.matchAll(/<tr><td>[^<]*<\/td><td>[^<]*<\/td><td>workspace_only<\/td><td>(\d+)<\/td>/g)];
  expect(rows.length).toBeGreaterThanOrEqual(2);
  for (const row of rows) expect(Number(row[1])).toBeGreaterThanOrEqual(1);
});

test('the page holds no value and makes no request', () => {
  for (const secret of [auth, encodeURIComponent(auth), overridePath, site.url, fakeWorkspace.gtm_preview]) expect(html).not.toContain(secret);
  expect(html).toContain('Content-Security-Policy');
  expect(html).not.toMatch(/<script|<link|<img|url\(|@import/i);
  expect((html.match(/<[^>]*>/g) ?? []).join('\n')).not.toMatch(/https?:/i);
});
