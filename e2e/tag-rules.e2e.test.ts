import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type RunRecords } from '../packages/core/src/index.ts';
import type { Summary } from '../packages/cli/src/summary.ts';
import { fakeEmail, fakeWorkspace } from '../fixtures/site/src/containers.ts';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';
import { afterAll, beforeAll, expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const auth = fakeWorkspace.gtm_auth;

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'tag-rules-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  summary: Summary | undefined;
  records: RunRecords | undefined;
}

const expectedTags = [
  { id: '11' },
  { id: '13', name: 'Meta - PageView' },
  { id: '45', name: 'GA4 - Purchase' },
  { id: '77' },
];

async function overrideFile(): Promise<string> {
  const path = join(outDir, `override-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: fakeWorkspace.gtm_preview, expectedTags }));
  return path;
}

function runCli(scenario: string, extra: string[]): Promise<CliRun> {
  const args = ['run', scenario, '--site', site.url, '--out', outDir, ...extra];
  const env = { ...process.env, TAGREEVE_TEST_GTM_ORIGIN: site.containerUrl };
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env }, async (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      let summary: Summary | undefined;
      try {
        summary = JSON.parse(stdout) as Summary;
      } catch {
        // text output
      }
      const path = summary?.path ?? /^Record: (.+)$/m.exec(stdout + stderr)?.[1];
      resolve({ code, stdout, stderr, summary, records: path ? await readRun(path) : undefined });
    });
  });
}

const scenario = join(root, 'e2e/scenarios/tag-rules.yml');
const b64 = (s: string) => Buffer.from(s).toString('base64');
// The middle of the base64 text does not depend on what precedes the value, so each alignment is covered.
const authForms = [auth, encodeURIComponent(auth), ...[0, 1, 2].map((k) => b64('A'.repeat(k) + auth).slice(4, -4))];

test('tag rules and expectedTags read the workspace build, with names filled and masked', async () => {
  site.tagReportLog.length = 0;
  const override = await overrideFile();
  const json = await runCli(scenario, ['--json', '--gtm-override', override]);
  const text = await runCli(scenario, ['--gtm-override', override]);

  // Preconditions: the record holds what the checks below look for.
  const { tagReports } = json.records!;
  const entry = (id: string) => tagReports.flatMap((r) => r.tags).find((t) => t.id === id);
  expect(entry('88')!.name).toContain(fakeEmail);
  expect(entry('89')!.name).toBe('[redacted]');
  expect(entry('13')).toMatchObject({ name: null, status: 'failure' });
  expect(entry('14')).toMatchObject({ name: null, status: 'success' });
  expect(site.tagReportLog.length).toBeGreaterThan(0);
  expect(site.tagReportLog.every((body) => (JSON.parse(body) as { tags: { id: string; name: string | null }[] }).tags.find((t) => t.id === '89')?.name?.includes(auth))).toBe(true);

  const tags = json.summary!.tags!['GTM-PWTEST1'] as { reports: number; fired: { id: string; name: string | null; nameFrom: string | null; statuses: Record<string, number> }[]; notFired: unknown };
  expect(tags.reports).toBe(tagReports.length);
  expect(tags.fired.map((t) => t.id)).toEqual(['11', '13', '14', '77', '88', '89']);
  expect(tags.notFired).toEqual([{ id: '45', name: 'GA4 - Purchase' }]);
  const fired = (id: string) => tags.fired.find((t) => t.id === id)!;
  expect(fired('13')).toMatchObject({ name: 'Meta - PageView', nameFrom: 'expectedTags' });
  expect(Object.keys(fired('13').statuses)).toEqual(['failure']);
  expect(fired('88').name).toBe('(other)');
  expect(fired('89').name).toBe('[redacted]');
  expect(fired('14')).toMatchObject({ name: null, nameFrom: null });

  expect(text.stdout).toMatch(/^Tags GTM-PWTEST1: 6 fired, 1 failed \(13 Meta - PageView: failure\), 1 expected did not fire \(45 GA4 - Purchase\)$/m);

  const result = (summary: Summary, needle: string) => summary.results.find((r) => r.expectation.includes(needle))!;
  const reportIds = new Set<string>(tagReports.map((r) => r.id));
  expect(result(json.summary!, '"id":"77"')).toMatchObject({ pass: true });
  const meta = result(json.summary!, 'Meta *');
  expect(meta.pass).toBe(false);
  expect(meta.evidence.length).toBeGreaterThan(0);
  expect(meta.evidence.every((id) => id.startsWith('tag_') && reportIds.has(id))).toBe(true);
  expect(meta.note).toBeUndefined();
  expect(meta.message).toContain('13 Meta - PageView');
  expect([...meta.evidence].sort()).toEqual(tagReports.filter((r) => r.tags.some((t) => t.id === '13')).map((r) => r.id).sort());
  expect(result(json.summary!, 'X *')).toMatchObject({ pass: false, note: 'tagNameUnknown' });
  expect(json.code).toBe(1);

  for (const out of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    expect(out).not.toContain(fakeEmail);
    for (const form of authForms) expect(out, form).not.toContain(form);
  }
  expect(text.stdout).not.toContain('Lead -');
}, 120_000);

test('a page without the reporter gives noTagReports, and an override run says to install the reporter', async () => {
  const path = join(outDir, 'no-reporter.yml');
  await writeFile(path, 'start: /container/direct\nsteps:\n  - wait: 2s\nexpect:\n  must:\n    - { tag: { id: "77" } }\n  mustNot:\n    - { tag: { id: "13" } }\noptions: { seed: 1, allowUnknownDestination: true }\n');
  const override = await overrideFile();
  const json = await runCli(path, ['--json', '--gtm-override', override]);
  const text = await runCli(path, ['--gtm-override', override]);
  expect(json.records!.tagReports).toEqual([]);

  const rules = (summary: Summary) => summary.results.filter((r) => /^must(Not)?: /.test(r.expectation));
  expect(rules(json.summary!).map((r) => r.note)).toEqual(['noTagReports', 'noTagReports']);
  expect(rules(json.summary!).every((r) => !r.pass)).toBe(true);
  expect(json.summary!.tags).toEqual({ 'GTM-PWTEST1': { reports: 0, hint: 'tagreeve template web --json' } });
  expect(text.stdout).toContain('Tags: no reports from GTM-PWTEST1. Install the reporter: tagreeve template web --json');
  expect(text.stdout).toContain('note: cannot evaluate: no tag report from this container. Install the reporter: tagreeve template web --json');

  const plain = await runCli(path, ['--json']);
  expect(rules(plain.summary!).map((r) => r.note)).toEqual(['noTagReports', 'noTagReports']);
  expect(plain.summary).not.toHaveProperty('tags');
}, 120_000);
