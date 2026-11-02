import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run, site } from './cli-helpers.ts';

const EMAIL = 'pw-fixture@example.com';

function baselineSave(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), 'baseline', 'save', ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

interface JsonSummary {
  ok: boolean;
  baseline?: { drift: boolean; added: number; removed: number; countChanges: number; warnings: string[]; changes: string[] };
}

test('a run matches its own baseline, and a run with an extra add_to_cart drifts and exits 1', async () => {
  const base = await run('baseline-base');
  expect(base.code).toBe(0);
  const baselinePath = join(outDir, 'baseline.json');
  const saved = await baselineSave([(JSON.parse(base.stdout) as { path: string }).path, baselinePath]);
  expect(saved.code).toBe(0);

  const same = await run('baseline-base', ['--baseline', baselinePath]);
  expect(same.code).toBe(0);
  const sameSummary = JSON.parse(same.stdout) as JsonSummary;
  expect(sameSummary.baseline).toMatchObject({ drift: false, added: 0, removed: 0 });
  expect(sameSummary.ok).toBe(true);

  const cart = await run('baseline-cart', ['--baseline', baselinePath]);
  expect(cart.code).toBe(1);
  const cartSummary = JSON.parse(cart.stdout) as JsonSummary;
  expect(cartSummary.ok).toBe(false);
  expect(cartSummary.baseline?.drift).toBe(true);
  expect(cartSummary.baseline?.added).toBeGreaterThan(0);
  expect(cartSummary.baseline?.changes.some((c) => c.startsWith('added ga4 add_to_cart'))).toBe(true);
  expect(cartSummary.baseline?.warnings.some((w) => w.includes('baseline-base.yml'))).toBe(true);

  const text = await new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(
      process.execPath,
      [join(root, 'dist/cli.js'), 'run', join(root, 'e2e/scenarios/baseline-cart.yml'), '--site', site.url, '--out', outDir, '--baseline', baselinePath],
      { cwd: root },
      (error, stdout) => resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout }),
    );
  });
  expect(text.code).toBe(1);
  expect(text.stdout).toMatch(/Baseline: drift \(\d+ added, \d+ removed, \d+ count changes\)/);
  expect(text.stdout).toContain('added ga4 add_to_cart');
  expect(text.stdout).toContain('Result: fail');
}, 180_000);

test('the baseline file holds no email, hash, cookie value, URL or query', async () => {
  const base = await run('baseline-base');
  const records = base.records!;
  const sha = createHash('sha256').update(EMAIL);
  const secrets = [EMAIL, encodeURIComponent(EMAIL), records.run.identity!.email, sha.copy().digest('hex'), sha.copy().digest('base64'), sha.copy().digest('base64url'), 'pw-fixture-cookie-value'];
  expect(JSON.stringify(records.requests)).toContain(EMAIL);

  for (const byPage of [false, true]) {
    const path = join(outDir, `leak-${byPage}.json`);
    const saved = await baselineSave([(JSON.parse(base.stdout) as { path: string }).path, path, ...(byPage ? ['--by-page'] : [])]);
    expect(saved.code).toBe(0);
    const file = await readFile(path, 'utf8');
    for (const secret of secrets) expect(file).not.toContain(secret);
    expect(file).not.toMatch(/https?:|\?|hit_|req_/);
    expect(file).toContain(byPage ? '"page": "/products/fake-tee"' : '"vendor": "ga4"');
    const result = await run('baseline-base', ['--baseline', path]);
    for (const secret of secrets) expect(result.stdout + result.stderr).not.toContain(secret);
  }
}, 180_000);

test('a missing or invalid baseline file exits 2 before a browser launches', async () => {
  const missing = await run('baseline-base', ['--baseline', join(outDir, 'nope.json')]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('nope.json');
  const bad = join(outDir, 'bad.json');
  await writeFile(bad, '{"baselineSchemaVersion": 1}');
  const invalid = await run('baseline-base', ['--baseline', bad]);
  expect(invalid.code).toBe(2);
  expect(invalid.stderr).toContain('not a valid baseline file');
  expect(invalid.records).toBeUndefined();
});
