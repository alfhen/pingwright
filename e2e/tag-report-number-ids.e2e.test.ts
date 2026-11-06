import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type RunRecords } from '../packages/core/src/index.ts';
import { fakeWorkspace, fixtureTags } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'tag-report-number-ids-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  summary: { tags?: Record<string, { reports: number }> } | undefined;
  records: RunRecords | undefined;
}

async function runWorkspace(): Promise<CliRun> {
  const override = join(outDir, 'override.json');
  await writeFile(override, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: fakeWorkspace.gtm_auth, gtmPreview: fakeWorkspace.gtm_preview }));
  const args = ['run', join(root, 'e2e/scenarios/tag-reports.yml'), '--site', site.url, '--out', outDir, '--json', '--gtm-override', override];
  const env = { ...process.env, TAGREEVE_TEST_GTM_ORIGIN: site.containerUrl };
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env }, async (error, stdout) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      let summary: CliRun['summary'];
      let path: string | undefined;
      try {
        const parsed = JSON.parse(stdout) as { path: string } & NonNullable<CliRun['summary']>;
        summary = parsed;
        path = parsed.path;
      } catch {
        // no JSON summary
      }
      resolve({ code, summary, records: path ? await readRun(path) : undefined });
    });
  });
}

test('tag reports from GTM number tag IDs are recorded, not rejected', async () => {
  // Precondition: the fixture gives number IDs, as real GTM does, so the template really receives numbers.
  expect(fixtureTags.workspace.every((t) => typeof t.id === 'number')).toBe(true);
  site.tagReportLog.length = 0;

  const r = await runWorkspace();
  expect(r.code).not.toBe(2);
  expect(site.tagReportLog.length).toBeGreaterThan(0);

  const { run, tagReports, invalidReports } = r.records!;
  expect(invalidReports).toEqual([]);
  expect(tagReports.length).toBeGreaterThan(0);
  for (const report of tagReports) {
    expect(report.tags.map((t) => t.id)).toEqual(['11', '13', '14', '77', '88', '89']);
  }
  expect(run.containerVersions['GTM-PWTEST1']).toBe('QUICK_PREVIEW');
  expect(r.summary!.tags!['GTM-PWTEST1']!.reports).toBeGreaterThan(0);
}, 90_000);
