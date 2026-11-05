import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run, runCli, scenario, site } from './cli-helpers.ts';

interface PushRef {
  epoch: string;
  event: string;
  frame: string;
}

interface PushDiff {
  eventsAdded: PushRef[];
  eventsRemoved: PushRef[];
  pathsAdded: (PushRef & { path: string })[];
  pathsRemoved: (PushRef & { path: string })[];
  typeChanges: (PushRef & { path: string; a: string[]; b: string[] })[];
  moved: { event: string; kind: string; from: string; to: string }[];
  changed: boolean;
}

interface JsonSummary {
  ok: boolean;
  baseline?: { drift: boolean; added: number; removed: number; warnings: string[] };
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const LEAKS = ['sku-1', '25.5', 'fake.person', 'example.test', 'gid://', '1234567890', 'deadbeef', 'pw-secret-value', 'tok-value'];

function expectNoLeaks(...outs: string[]) {
  for (const out of outs) for (const leak of LEAKS) expect(out).not.toContain(leak);
}

async function recordBuilds() {
  const a = await run('datalayer-build-a');
  const b = await run('datalayer-build-b');
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const cart = (r: typeof a) => r.records!.dataLayerEvents.filter((e) => e.event === 'add_to_cart');
  expect(a.records!.dataLayerEvents.some((e) => e.event === 'purchase')).toBe(true);
  expect(cart(a).map((e) => e.frame?.main)).toEqual([false]);
  expect(cart(b).map((e) => e.frame?.main)).toEqual([true]);
  const args = JSON.stringify(b.records!.dataLayerEvents.map((e) => e.args)) + JSON.stringify(a.records!.dataLayerEvents.map((e) => e.args));
  for (const leak of LEAKS) expect(args + JSON.stringify(b.records!.dataLayerEvents.map((e) => e.event))).toContain(leak);
  return { a: (JSON.parse(a.stdout) as { path: string }).path, b: (JSON.parse(b.stdout) as { path: string }).path };
}

test('diff names the missing path, the type change and the frame move, and never prints a pushed value', async () => {
  const { a, b } = await recordBuilds();

  const json = await cli(['diff', a, b, '--json']);
  expect(json.code).toBe(0);
  const d = (JSON.parse(json.stdout) as { dataLayer: PushDiff }).dataLayer;
  expect(d.pathsRemoved).toEqual([expect.objectContaining({ event: 'purchase', frame: 'main', path: 'ecommerce.value' })]);
  expect(d.pathsAdded).toEqual([expect.objectContaining({ event: 'purchase', path: 'extra.(other)' })]);
  expect(d.typeChanges).toEqual([expect.objectContaining({ event: 'purchase', path: 'value', a: ['number'], b: ['string'] })]);
  expect(d.eventsRemoved).toEqual([expect.objectContaining({ event: 'add_to_cart', frame: 'embedded' })]);
  expect(d.eventsAdded).toEqual(expect.arrayContaining([expect.objectContaining({ event: 'add_to_cart', frame: 'main' }), expect.objectContaining({ event: '(other)' })]));

  const text = await cli(['diff', a, b]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('missing path ecommerce.value (number) in purchase');
  expect(text.stdout).toContain('type change value: number -> string in purchase');
  expect(text.stdout).toContain('removed event add_to_cart');
  expect(text.stdout).toContain('new event add_to_cart');
  expect(text.stdout).toContain('new event (other)');

  const merged = await cli(['diff', a, b, '--across-frames', '--json']);
  expect(merged.code).toBe(0);
  const m = (JSON.parse(merged.stdout) as { dataLayer: PushDiff }).dataLayer;
  expect(m.eventsRemoved).toEqual([]);
  expect(m.eventsAdded.map((e) => e.event)).toEqual(['(other)']);
  expect(m.moved).toEqual([expect.objectContaining({ event: 'add_to_cart', kind: 'frame', from: 'embedded', to: 'main' })]);
  expect(m.pathsRemoved.map((p) => p.path)).toEqual(['ecommerce.value']);

  expectNoLeaks(json.stdout, json.stderr, text.stdout, text.stderr, merged.stdout, merged.stderr);
}, 240_000);

test('a baseline of build a and a run of build b exit 0 with push warnings, and an rc.1 baseline still loads', async () => {
  const { a } = await recordBuilds();
  const baselinePath = join(outDir, 'datalayer-baseline.json');
  const saved = await cli(['baseline', 'save', a, baselinePath]);
  expect(saved.code).toBe(0);
  const file = await readFile(baselinePath, 'utf8');
  expect(JSON.parse(file).dataLayer).toBeDefined();
  expectNoLeaks(file, saved.stdout, saved.stderr);

  const b = await run('datalayer-build-b', ['--baseline', baselinePath]);
  expect(b.code).toBe(0);
  const summary = JSON.parse(b.stdout) as JsonSummary;
  expect(summary.ok).toBe(true);
  expect(summary.baseline?.drift).toBe(false);
  const warnings = summary.baseline!.warnings;
  expect(warnings).toContain('dataLayer missing path ecommerce.value (number) in purchase [epoch undecided, frame main]');
  expect(warnings).toContain('dataLayer type change value: number -> string in purchase [epoch undecided, frame main]');
  expect(warnings.some((w) => w.startsWith('dataLayer removed event add_to_cart'))).toBe(true);
  expect(warnings.some((w) => w.includes('(other)'))).toBe(true);
  expectNoLeaks(b.stdout, b.stderr);
  const text = await runCli(['run', scenario('datalayer-build-b'), '--site', site.url, '--out', outDir, '--baseline', baselinePath]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('dataLayer missing path ecommerce.value');
  expectNoLeaks(text.stdout, text.stderr);

  const rc1 = JSON.parse(file) as Record<string, unknown>;
  delete rc1.dataLayer;
  const rc1Path = join(outDir, 'datalayer-baseline-rc1.json');
  await writeFile(rc1Path, JSON.stringify(rc1));
  const old = await run('datalayer-build-b', ['--baseline', rc1Path]);
  expect(old.code).toBe(0);
  const oldSummary = JSON.parse(old.stdout) as JsonSummary;
  expect(oldSummary.baseline?.warnings.some((w) => w.startsWith('dataLayer pushes not compared'))).toBe(true);
  expect(oldSummary.baseline?.warnings.some((w) => w.startsWith('dataLayer missing path'))).toBe(false);
}, 240_000);

test('--across-frames is for diff only', async () => {
  const { a } = await recordBuilds();
  const onRun = await runCli(['run', scenario('datalayer-build-a'), '--site', site.url, '--out', outDir, '--across-frames']);
  expect(onRun.code).toBe(2);
  expect(onRun.stderr).toContain('--across-frames is only for diff');
  const onSave = await cli(['baseline', 'save', a, join(outDir, 'across.json'), '--across-frames']);
  expect(onSave.code).toBe(2);
}, 240_000);
