import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, root, run } from './cli-helpers.ts';

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

const LEAKS = ['sku-1', '25.5'];

async function recordBuilds() {
  const a = await run('datalayer-build-a');
  const b = await run('datalayer-build-b');
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  const cart = (r: typeof a) => r.records!.dataLayerEvents.filter((e) => e.event === 'add_to_cart');
  expect(a.records!.dataLayerEvents.some((e) => e.event === 'purchase')).toBe(true);
  expect(cart(a).map((e) => e.frame?.main)).toEqual([false]);
  expect(cart(b).map((e) => e.frame?.main)).toEqual([true]);
  return { a: (JSON.parse(a.stdout) as { path: string }).path, b: (JSON.parse(b.stdout) as { path: string }).path };
}

test('diff names the missing path, the type change and the frame move, and never prints a pushed value', async () => {
  const { a, b } = await recordBuilds();

  const json = await cli(['diff', a, b, '--json']);
  expect(json.code).toBe(0);
  const d = (JSON.parse(json.stdout) as { dataLayer: PushDiff }).dataLayer;
  expect(d.pathsRemoved).toEqual([expect.objectContaining({ event: 'purchase', frame: 'main', path: 'ecommerce.value' })]);
  expect(d.typeChanges).toEqual([expect.objectContaining({ event: 'purchase', path: 'value', a: ['number'], b: ['string'] })]);
  expect(d.eventsRemoved).toEqual([expect.objectContaining({ event: 'add_to_cart', frame: 'embedded' })]);
  expect(d.eventsAdded).toEqual([expect.objectContaining({ event: 'add_to_cart', frame: 'main' })]);

  const text = await cli(['diff', a, b]);
  expect(text.code).toBe(0);
  expect(text.stdout).toContain('missing path ecommerce.value (number) in purchase');
  expect(text.stdout).toContain('type change value: number -> string in purchase');
  expect(text.stdout).toContain('removed event add_to_cart');
  expect(text.stdout).toContain('new event add_to_cart');

  const merged = await cli(['diff', a, b, '--across-frames', '--json']);
  expect(merged.code).toBe(0);
  const m = (JSON.parse(merged.stdout) as { dataLayer: PushDiff }).dataLayer;
  expect(m.eventsRemoved).toEqual([]);
  expect(m.eventsAdded).toEqual([]);
  expect(m.moved).toEqual([expect.objectContaining({ event: 'add_to_cart', kind: 'frame', from: 'embedded', to: 'main' })]);
  expect(m.pathsRemoved.map((p) => p.path)).toEqual(['ecommerce.value']);

  for (const out of [json, text, merged]) {
    for (const leak of LEAKS) {
      expect(out.stdout).not.toContain(leak);
      expect(out.stderr).not.toContain(leak);
    }
  }
}, 240_000);

test('a baseline of build a and a run of build b exit 0 with push warnings, and an rc.1 baseline still loads', async () => {
  const { a } = await recordBuilds();
  const baselinePath = join(outDir, 'datalayer-baseline.json');
  const saved = await cli(['baseline', 'save', a, baselinePath]);
  expect(saved.code).toBe(0);
  const file = await readFile(baselinePath, 'utf8');
  expect(JSON.parse(file).dataLayer).toBeDefined();
  for (const leak of LEAKS) expect(file).not.toContain(leak);

  const b = await run('datalayer-build-b', ['--baseline', baselinePath]);
  expect(b.code).toBe(0);
  const summary = JSON.parse(b.stdout) as JsonSummary;
  expect(summary.ok).toBe(true);
  expect(summary.baseline?.drift).toBe(false);
  const warnings = summary.baseline!.warnings;
  expect(warnings).toContain('dataLayer missing path ecommerce.value (number) in purchase [epoch undecided, frame main]');
  expect(warnings).toContain('dataLayer type change value: number -> string in purchase [epoch undecided, frame main]');
  expect(warnings.some((w) => w.startsWith('dataLayer removed event add_to_cart'))).toBe(true);
  expect(b.stdout).not.toContain('sku-1');

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
