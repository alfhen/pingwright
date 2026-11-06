import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type RunRecords, type TagReport } from '../packages/core/src/index.ts';
import { fakeWorkspace } from '../fixtures/site/src/containers.ts';
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
  outDir = await mkdtemp(join(parent, 'tag-reports-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  path: string | undefined;
  records: RunRecords | undefined;
}

async function overrideFile(): Promise<string> {
  const path = join(outDir, `override-${Math.random().toString(36).slice(2)}.json`);
  await writeFile(path, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: fakeWorkspace.gtm_preview }));
  return path;
}

function runCli(extra: string[]): Promise<CliRun> {
  const args = ['run', join(root, 'e2e/scenarios/tag-reports.yml'), '--site', site.url, '--out', outDir, '--json', ...extra];
  const env = { ...process.env, TAGREEVE_TEST_GTM_ORIGIN: site.containerUrl };
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root, env }, async (error, stdout, stderr) => {
      const code = error ? ((error as { code?: number }).code ?? 1) : 0;
      let path: string | undefined;
      try {
        path = (JSON.parse(stdout) as { path: string }).path;
      } catch {
        path = /^Record: (.+)$/m.exec(stderr)?.[1];
      }
      resolve({ code, stdout, stderr, path, records: path ? await readRun(path) : undefined });
    });
  });
}

const statusOf = (report: TagReport, id: string) => report.tags.find((t) => t.id === id)?.status;
const b64 = (s: string) => Buffer.from(s).toString('base64');
// The middle of the base64 text does not depend on what precedes the value, so each alignment is covered.
const forms = [auth, encodeURIComponent(auth), ...[0, 1, 2].map((k) => b64('A'.repeat(k) + auth).slice(4, -4))];

test('the published build reports its tags per event from the main frame and a sandboxed iframe', async () => {
  site.tagReportLog.length = 0;
  const r = await runCli([]);
  expect(r.code).not.toBe(2);
  const { run, tagReports } = r.records!;
  // Precondition: the shim called the binding, so an empty record below can only mean the recorder dropped the reports.
  expect(site.tagReportLog.length).toBeGreaterThanOrEqual(4);

  expect(tagReports.every((t) => t.side === 'web' && t.container === 'GTM-PWTEST1')).toBe(true);
  for (const main of [true, false]) {
    const frame = tagReports.filter((t) => t.frame?.main === main);
    expect(frame.map((t) => t.event).sort(), `main ${main}`).toEqual(['container_event', 'gtm.js']);
  }
  expect(new Set(tagReports.filter((t) => !t.frame!.main).map((t) => t.frame!.n)).size).toBe(1);
  expect(tagReports.find((t) => t.frame!.main)!.frame!.n).not.toBe(tagReports.find((t) => !t.frame!.main)!.frame!.n);
  for (const t of tagReports) {
    expect(t.t).toBeGreaterThan(run.startedAt);
    expect(t.stepId, 'stepId').not.toBeNull();
    expect(statusOf(t, '11')).toBe('success');
    expect(statusOf(t, '12')).toBe('failure');
    expect(statusOf(t, '45')).toBeUndefined();
    expect(t.gtmUniqueEventId).toEqual(expect.any(Number));
  }
  expect(run.containerVersions['GTM-PWTEST1']).toBe('3');
  expect(r.records!.invalidReports).toEqual([]);

  const frames = new Set(r.records!.requests.map((q) => q.frame?.n));
  expect(frames.has(tagReports.find((t) => !t.frame!.main)!.frame!.n)).toBe(true);
  expect(r.records!.requests.every((q) => q.frame !== undefined)).toBe(true);
}, 90_000);

test('with --gtm-override the workspace tags are reported, and the auth in a tag name never reaches the record or the output', async () => {
  site.tagReportLog.length = 0;
  const r = await runCli(['--gtm-override', await overrideFile()]);
  expect(r.code).not.toBe(2);
  const { run, tagReports } = r.records!;
  expect(tagReports.length).toBeGreaterThan(0);
  for (const t of tagReports) {
    expect(statusOf(t, '77')).toBe('success');
    expect(statusOf(t, '13')).toBe('failure');
    expect(statusOf(t, '14')).toBe('success');
    expect(statusOf(t, '12')).toBeUndefined();
    expect(statusOf(t, '45')).toBeUndefined();
  }
  expect(run.containerVersions['GTM-PWTEST1']).toBe('QUICK_PREVIEW');

  // Positive control from outside the scrubbed record: the fixture's own log shows the page sent the auth in tag 89's name.
  const logged = site.tagReportLog.map((body) => JSON.parse(body) as { tags: { id: string; name: string | null }[] });
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.every((p) => p.tags.find((t) => t.id === '89')?.name?.includes(auth))).toBe(true);

  for (const t of tagReports) expect(t.tags.find((x) => x.id === '89')!.name).toBe('[redacted]');
  const text = await readFile(r.path!, 'utf8');
  expect(text).toContain('"type":"tagReport"');
  for (const form of forms) {
    expect(text, form).not.toContain(form);
    expect(r.stdout, form).not.toContain(form);
    expect(r.stderr, form).not.toContain(form);
  }
}, 90_000);
