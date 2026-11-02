import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run, runCli, scenario, site, type CliRun } from './cli-helpers.ts';

const EMAIL = 'pw-fixture@example.com';
const COOKIE_VALUE = 'pw-fixture-cookie-value';

function baselineSave(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), 'baseline', 'save', ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

interface JsonSummary {
  ok: boolean;
  pass: boolean;
  results: { pass: boolean }[];
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
  expect(sameSummary.pass).toBe(sameSummary.results.every((r) => r.pass));

  const cart = await run('baseline-cart', ['--baseline', baselinePath]);
  expect(cart.code).toBe(1);
  const cartSummary = JSON.parse(cart.stdout) as JsonSummary;
  expect(cartSummary.ok).toBe(false);
  expect(cartSummary.pass).toBe(false);
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
  const base = await run('baseline-leak');
  const records = base.records!;
  const otherHash = '88f45d748ead76a339d3815f0b475088eb8b9621cad412386906e15209bfa045';
  const sha = createHash('sha256').update(EMAIL);
  const identitySecrets = [EMAIL, encodeURIComponent(EMAIL), sha.copy().digest('hex'), sha.copy().digest('base64'), sha.copy().digest('base64url')];
  const secrets = [otherHash, ...identitySecrets];
  expect(JSON.stringify(records.requests)).toContain(otherHash);
  const hitParams = JSON.stringify(records.hits.map((h) => h.params));
  for (const secret of identitySecrets.filter((s) => s !== encodeURIComponent(EMAIL))) expect(hitParams).toContain(secret);
  expect(hitParams).toContain(COOKIE_VALUE);
  expect(JSON.stringify(records.checkpoints)).toContain('_pwalready');
  expect(records.requests.some((r) => r.url.includes('/set-cookie-already'))).toBe(true);

  for (const byPage of [false, true]) {
    const path = join(outDir, `leak-${byPage}.json`);
    const saved = await baselineSave([(JSON.parse(base.stdout) as { path: string }).path, path, ...(byPage ? ['--by-page'] : [])]);
    expect(saved.code).toBe(0);
    const file = await readFile(path, 'utf8');
    for (const secret of secrets) expect(file).not.toContain(secret);
    expect(file).not.toMatch(/https?:|\?|hit_|req_|_pwalready|pw-fixture-cookie-value/);
    expect(file).toContain(byPage ? '"page": "/shared-hashes"' : '"vendor": "ga4"');
    const result = await run('baseline-leak', ['--baseline', path]);
    for (const secret of [...identitySecrets, COOKIE_VALUE]) expect(result.stdout + result.stderr).not.toContain(secret);
  }
}, 180_000);

test('a hit that moved across one consent answer is a moved line and no drift, in both directions', async () => {
  const undecided = await run('baseline-moved');
  expect(undecided.code).toBe(0);
  const granted = join(outDir, 'granted');
  await mkdir(granted, { recursive: true });
  const early = await readFile(scenario('baseline-moved'), 'utf8');
  const [evalStep, ...afterEval] = early.slice(early.indexOf('  - evaluate')).split('  - consent: accept\n');
  const late = early.slice(0, early.indexOf('  - evaluate')) + '  - consent: accept\n' + evalStep + afterEval.join('');
  const evalAt = (text: string) => text.indexOf('  - evaluate');
  expect(late).not.toBe(early);
  expect(evalAt(late)).toBeGreaterThan(late.indexOf('  - consent: accept'));
  expect(evalAt(early)).toBeLessThan(early.indexOf('  - consent: accept'));
  const lateScenario = join(granted, 'baseline-moved.yml');
  await writeFile(lateScenario, late);

  const labelOfPageView = (records: NonNullable<CliRun['records']>) => {
    const t = records.hits.find((h) => h.vendor === 'ga4' && h.event === 'page_view')!.t;
    return records.consentEpochs.find((e) => t >= e.startT && (e.endT === null || t < e.endT))!.label;
  };
  const lateRun = await runCli(['run', lateScenario, '--site', site.url, '--out', outDir, '--json']);
  expect(labelOfPageView(undecided.records!)).toBe('undecided');
  expect(labelOfPageView(lateRun.records!)).toBe('granted');

  for (const [from, to, against, label] of [
    [undecided, lateRun, 'undecided-baseline.json', 'undecided to granted'],
    [lateRun, undecided, 'granted-baseline.json', 'granted to undecided'],
  ] as const) {
    const baselinePath = join(outDir, against);
    const saved = await baselineSave([(JSON.parse(from.stdout) as { path: string }).path, baselinePath]);
    expect(saved.code).toBe(0);
    const scenarioPath = to === lateRun ? lateScenario : scenario('baseline-moved');
    const compared = await runCli(['run', scenarioPath, '--site', site.url, '--out', outDir, '--json', '--baseline', baselinePath]);
    expect(compared.code).toBe(0);
    const summary = JSON.parse(compared.stdout) as JsonSummary;
    expect(summary.baseline).toMatchObject({ drift: false, added: 0, removed: 0 });
    expect(summary.baseline?.warnings.some((w) => w.includes(`moved ga4 page_view from ${label}`))).toBe(true);
    expect(summary.ok).toBe(true);
  }
}, 240_000);

test('drift sets pass to false even when every result passed', async () => {
  const base = await run('baseline-moved');
  expect(base.code).toBe(0);
  const baselinePath = join(outDir, 'pass-baseline.json');
  expect((await baselineSave([(JSON.parse(base.stdout) as { path: string }).path, baselinePath])).code).toBe(0);
  const early = await readFile(scenario('baseline-moved'), 'utf8');
  const dir = join(outDir, 'drift');
  await mkdir(dir, { recursive: true });
  const driftScenario = join(dir, 'baseline-moved.yml');
  await writeFile(driftScenario, early.replace('  - wait: 500ms\n', "  - evaluate: \"new Image().src = 'https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=7777777777.8888888888&en=generate_lead'; true\"\n  - wait: 500ms\n"));
  const drifted = await runCli(['run', driftScenario, '--site', site.url, '--out', outDir, '--json', '--baseline', baselinePath]);
  const summary = JSON.parse(drifted.stdout) as JsonSummary;
  expect(summary.results.every((r) => r.pass)).toBe(true);
  expect(summary.baseline?.drift).toBe(true);
  expect(drifted.code).toBe(1);
  expect(summary.ok).toBe(false);
  expect(summary.pass).toBe(false);
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
