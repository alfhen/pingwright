import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run, runCli, scenario, site } from './cli-helpers.ts';

interface JsonSummary {
  ok: boolean;
  path: string;
  results: { pass: boolean; severity: string }[];
  baseline?: { drift: boolean; warnings: string[] };
}

function save(runPath: string, out: string): Promise<number> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), 'baseline', 'save', runPath, out], { cwd: root }, (error) => {
      resolve(error ? ((error as { code?: number }).code ?? 1) : 0);
    });
  });
}

test('the Result line counts the results at warn plus the baseline warnings', async () => {
  const a = await run('datalayer-build-a');
  expect(a.code).toBe(0);
  const baselinePath = join(outDir, 'warning-count-baseline.json');
  expect(await save((JSON.parse(a.stdout) as JsonSummary).path, baselinePath)).toBe(0);

  const json = await run('datalayer-build-b', ['--baseline', baselinePath]);
  expect(json.code).toBe(0);
  const summary = JSON.parse(json.stdout) as JsonSummary;
  const baselineWarnings = summary.baseline!.warnings;
  expect(baselineWarnings.some((w) => w.startsWith('dataLayer'))).toBe(true);
  const resultWarnings = summary.results.filter((r) => !r.pass && r.severity === 'warn').length;
  const count = resultWarnings + baselineWarnings.length;

  const text = await runCli(['run', scenario('datalayer-build-b'), '--site', site.url, '--out', outDir, '--baseline', baselinePath]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain(`Result: pass with ${count} warning${count === 1 ? '' : 's'}\n`);
}, 240_000);
