import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run } from './cli-helpers.ts';

const cli = join(root, 'dist/cli.js');

function report(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, 'report', ...args], { cwd: root }, (error, _stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stderr });
    });
  });
}

test('report --html marks the sgtm row as a leak and holds no value from the run', async () => {
  const r = await run('report-identifiers');
  expect(r.code).toBe(1);
  const summary = JSON.parse(r.stdout) as { path: string };
  const records = r.records!;
  const email = records.run.identity!.email;
  const hash = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  expect(records.hits.some((h) => h.vendor === 'sgtm' && h.idFields?.includes('external_id'))).toBe(true);

  const out = join(outDir, 'report.html');
  expect((await report([summary.path, '--html', out])).code).toBe(0);
  const html = await readFile(out, 'utf8');

  for (const [vendor, label] of [['sgtm', 'server container \\(sgtm\\)'], ['meta', 'Meta \\(meta\\)']]) {
    const row = new RegExp(`<tr><th scope="row">${label}</th>.*?</tr>`).exec(html);
    expect(row, vendor).not.toBeNull();
    expect(row![0], vendor).toContain('class="m-leak"');
  }
  expect(html).toContain('params.em');
  for (const secret of [email, hash, 'pw-fixture@example.com', 'fixture-user-0001', '0123456789abcdef0123456789abcdef']) {
    expect(html).not.toContain(secret);
  }
  expect(html).toContain('Content-Security-Policy');
  expect(html).not.toMatch(/<script|<link|<img|url\(|@import/i);
  expect((html.match(/<[^>]*>/g) ?? []).join('\n')).not.toMatch(/https?:/i);
}, 120_000);

test('report exits 2 for a missing file and for a file that is not a run record', async () => {
  expect((await report([join(outDir, 'nope.jsonl'), '--html', join(outDir, 'x.html')])).code).toBe(2);
  expect((await report([join(root, 'package.json'), '--html', join(outDir, 'y.html')])).code).toBe(2);
});
