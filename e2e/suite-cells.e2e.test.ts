import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const EMAIL = 'pw-fixture@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');

let site: FixtureSite;
let outDir: string;
let table: string;
let html: string;
let pairTable: string;
let pairHtml: string;
let recordText: string;

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
  outDir = await mkdtemp(join(parent, 'suite-cells-'));
  const out = join(outDir, 'runs');
  const suite = await node(['suite', join(root, 'e2e/suites/cells'), '--site', site.url, '--out', out]);
  expect(suite.code, suite.stderr).toBe(1);
  table = suite.stdout;
  const [name] = await readdir(out);
  const page = join(outDir, 'suite.html');
  const report = await node(['report', join(out, name!), '--html', page]);
  expect(report.code, report.stderr).toBe(0);
  html = await readFile(page, 'utf8');
  const runDir = join(out, name!);
  const files = (await readdir(runDir)).filter((f) => f.endsWith('.jsonl'));
  recordText = (await Promise.all(files.map((f) => readFile(join(runDir, f), 'utf8')))).join('\n');

  const overridePath = join(outDir, 'workspace-override.json');
  await writeFile(overridePath, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: fakeWorkspace.gtm_auth, gtmPreview: fakeWorkspace.gtm_preview }));
  const pairOut = join(outDir, 'pair-runs');
  const pair = await node(
    ['suite', join(root, 'e2e/suites/mixed'), '--site', site.url, '--out', pairOut, '--variant', 'published', '--variant', `workspace=${overridePath}`],
    { ...process.env, PINGWRIGHT_TEST_GTM_ORIGIN: site.containerUrl },
  );
  expect(pair.code, pair.stderr).toBe(1);
  pairTable = pair.stdout;
  const [pairName] = await readdir(pairOut);
  const pairPage = join(outDir, 'pair.html');
  const pairReport = await node(['report', join(pairOut, pairName!), '--html', pairPage]);
  expect(pairReport.code, pairReport.stderr).toBe(0);
  pairHtml = await readFile(pairPage, 'utf8');
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('the terminal table names the failed rule count and the built-in check', () => {
  const row = (name: string) => table.split('\n').find((l) => l.startsWith(name));
  expect(row('leak'), table).toMatch(/^leak\s+FAIL: 1 rule, deniedIdentifiers\s*$/m);
  expect(row('warned'), table).toMatch(/^warned\s+WARN: deniedIdentifiers\s*$/m);
  expect(row('clean'), table).toMatch(/^clean\s+PASS\s*$/m);
  expect(table).not.toContain('FAIL (exit 1)');
});

test('the report cell says the same', () => {
  expect(html).toContain('leak</th><td>FAIL: 1 rule, deniedIdentifiers</td>');
  expect(html).toContain('warned</th><td>WARN: deniedIdentifiers</td>');
  expect(html).toContain('clean</th><td>PASS</td>');
  expect(html).not.toContain('FAIL (exit 1)');
});

test('the verdict comes first, then the results table, the timelines, and the diff tables last', () => {
  const at = (text: string) => html.indexOf(text);
  const positions = [at('<h2>Verdict</h2>'), at('<h2>Results</h2>'), at('Timeline per vendor'), at('<h2>Diff per variant pair</h2>')];
  expect(positions.every((p) => p >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(html.lastIndexOf('Timeline per vendor')).toBeLessThan(positions[3]!);
  expect(html).toMatch(/<li><strong>published:<\/strong> identifiers go out to ga4, meta and sgtm in the denied state, 2 failed expectations, 1 accepted warning<\/li>/);
});

test('the table and the page hold no identity value', () => {
  expect(recordText, 'positive control: the records carry the hash').toContain(HASH);
  for (const secret of [EMAIL, HASH]) {
    expect(table).not.toContain(secret);
    expect(html).not.toContain(secret);
  }
});

test('with two variants the cell of the failing variant names its rule, and the diff tables are last', () => {
  expect(pairTable).toMatch(/^no-workspace-event\s+PASS\s+FAIL: 1 rule\s/m);
  expect(pairHtml).toContain('no-workspace-event</th><td>PASS</td><td>FAIL: 1 rule</td>');
  const diff = pairHtml.indexOf('<h2>Diff per variant pair</h2>');
  expect(diff).toBeGreaterThan(pairHtml.lastIndexOf('Timeline per vendor'));
  expect(pairHtml.indexOf('<h2>Verdict</h2>')).toBeLessThan(pairHtml.indexOf('<h2>Results</h2>'));
  expect(pairHtml.slice(diff)).toContain('workspace_only');
  expect(pairHtml).toMatch(/<li><strong>workspace:<\/strong> [^<]*1 failed expectation[^<]*<\/li>/);
});
