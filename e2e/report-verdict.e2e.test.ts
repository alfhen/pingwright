import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const EMAIL = 'pw-fixture@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');

let site: FixtureSite;
let outDir: string;
let html: string;
let recordText: string;

function node(args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'report-verdict-'));
  const out = join(outDir, 'runs');
  const suite = await node(['suite', join(root, 'e2e/suites/verdict'), '--site', site.url, '--out', out]);
  expect(suite.code, suite.stderr).toBe(1);
  const [name] = await readdir(out);
  const runDir = join(out, name!);
  const page = join(outDir, 'suite.html');
  const report = await node(['report', runDir, '--html', page]);
  expect(report.code, report.stderr).toBe(0);
  html = await readFile(page, 'utf8');
  const files = (await readdir(runDir)).filter((f) => f.endsWith('.jsonl'));
  recordText = (await Promise.all(files.map((f) => readFile(join(runDir, f), 'utf8')))).join('\n');
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

test('the verdict names the failed built-in check and the run count, not failed expectations', () => {
  const verdict = /<li><strong>published:<\/strong> ([^<]*)<\/li>/.exec(html)?.[1];
  expect(verdict, html).toBeDefined();
  expect(verdict).toContain('built-in check sandboxPageUrl failed in 2 runs');
  expect(verdict).toContain('1 rule failed');
  expect(html).not.toContain('failed expectation');
});

test('the verdict names leaking vendors by their plain name', () => {
  expect(html).toContain(
    '<li><strong>published:</strong> identifiers go out to Google Analytics 4, Meta and server container in the denied state; 1 rule failed; built-in check sandboxPageUrl failed in 2 runs</li>',
  );
});

test('timeline rows read Name (key) and the title says what was tested', () => {
  expect(html).toContain('<th scope="row">server container (sgtm)</th>');
  expect(html).toContain('<th scope="row">Google Analytics 4 (ga4)</th>');
  const title = new RegExp(`<title>Pingwright suite: published on [^,<]+:\\d+, \\d{4}-\\d{2}-\\d{2}</title>`);
  expect(html).toMatch(title);
  expect(html).not.toMatch(/<h1>Suite /);
  expect(html).toMatch(/<dt>Suite<\/dt><dd>suite_/);
});

test('the records carry the email hash and the page does not', () => {
  expect(recordText, 'positive control: the records carry the hash').toContain(HASH);
  for (const secret of [EMAIL, HASH]) expect(html).not.toContain(secret);
});
