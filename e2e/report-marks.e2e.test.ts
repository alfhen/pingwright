import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run } from './cli-helpers.ts';

function renderHtml(path: string, out: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), 'report', path, '--html', out], { cwd: root }, (error) => {
      resolve(error ? ((error as { code?: number }).code ?? 1) : 0);
    });
  });
}

test('a Meta hit before any answer is early, severity shows only on a failed result, and --json has severity on every result', async () => {
  const r = await run('report-marks');
  expect(r.code).toBe(1);
  const summary = JSON.parse(r.stdout) as { path: string; results: { pass: boolean; severity?: string }[] };
  expect(summary.results.length).toBeGreaterThan(2);
  expect(summary.results.some((x) => x.pass)).toBe(true);
  expect(summary.results.every((x) => x.severity === 'fail')).toBe(true);

  const out = join(outDir, 'report-marks.html');
  expect(await renderHtml(summary.path, out)).toBe(0);
  const html = await readFile(out, 'utf8');

  const row = /<tr><th scope="row">meta<\/th>.*?<\/tr>/.exec(html);
  expect(row).not.toBeNull();
  expect(row![0]).toContain('class="m-early"');
  expect(row![0]).toContain('before an answer');
  expect(row![0]).not.toContain('class="m-full"');

  expect(html).not.toContain('severity: fail');
  const passing = /<li class="s-pass">.*?<\/li>/.exec(html);
  expect(passing![0]).not.toContain('severity');
  const failing = /<li class="s-fail">.*?<\/li>/.exec(html);
  expect(failing![0]).toContain('on failure: fail');

  const email = r.records!.run.identity?.email;
  for (const secret of [email, 'pw-fixture@example.com'].filter((x): x is string => !!x)) expect(html).not.toContain(secret);
  expect(html).not.toMatch(/<script|<link|<img|url\(|@import/i);
}, 120_000);
