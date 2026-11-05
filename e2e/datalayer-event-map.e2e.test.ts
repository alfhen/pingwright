import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
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
  changed: boolean;
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), ...args], { cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

const mapFile = join(root, 'e2e/scenarios/event-map.json');

async function recordBuilds() {
  const a = await run('datalayer-event-map-a');
  const b = await run('datalayer-event-map-b');
  expect(a.code).toBe(0);
  expect(b.code).toBe(0);
  expect(a.records!.dataLayerEvents.map((e) => e.event)).toEqual(['checkout_completed', 'legacy_promo', 'cart_update']);
  expect(b.records!.dataLayerEvents.map((e) => e.event)).toEqual(['purchase', 'promo_selected', 'cart_update']);
  return { a: (JSON.parse(a.stdout) as { path: string }).path, b: (JSON.parse(b.stdout) as { path: string }).path };
}

test('the built-in table makes checkout_completed and purchase the same event, and a user map covers the rest', async () => {
  const { a, b } = await recordBuilds();

  const plain = await cli(['diff', a, b, '--json']);
  expect(plain.code).toBe(0);
  const d = (JSON.parse(plain.stdout) as { dataLayer: PushDiff }).dataLayer;
  expect(d.eventsRemoved.map((e) => e.event)).toEqual(['legacy_promo']);
  expect(d.eventsAdded.map((e) => e.event)).toEqual(['promo_selected']);
  expect(d.pathsRemoved).toEqual([expect.objectContaining({ event: 'cart_update', path: 'cart.total' })]);
  expect(d.pathsAdded).toEqual([expect.objectContaining({ event: 'cart_update', path: 'cart.amount' })]);
  expect(plain.stdout).not.toContain('checkout_completed');

  const mapped = await cli(['diff', a, b, '--event-map', mapFile, '--json']);
  expect(mapped.code).toBe(0);
  const m = (JSON.parse(mapped.stdout) as { dataLayer: PushDiff }).dataLayer;
  expect(m.changed).toBe(false);
  const text = await cli(['diff', a, b, '--event-map', mapFile]);
  expect(text.code).toBe(0);
  expect(text.stdout).not.toContain('dataLayer');

  for (const out of [plain, mapped, text]) {
    expect(out.stdout + out.stderr).not.toContain('pw-secret-value');
  }
}, 240_000);

test('an event map file error names the file and the key, never a value', async () => {
  const { a, b } = await recordBuilds();
  const bad = join(outDir, 'bad-event-map.json');
  await writeFile(bad, JSON.stringify({ events: { legacy_promo: 42, other: 'pw-secret-value-9' } }));
  const result = await cli(['diff', a, b, '--event-map', bad]);
  expect(result.code).toBe(2);
  expect(result.stderr).toContain(bad);
  expect(result.stderr).toContain('events.legacy_promo');
  expect(result.stderr).not.toContain('pw-secret-value');

  const missing = await cli(['diff', a, b, '--event-map', join(outDir, 'nope.json')]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain('nope.json');

  const onRun = await cli(['baseline', 'save', a, join(outDir, 'em-baseline.json'), '--event-map', mapFile]);
  expect(onRun.code).toBe(2);
  expect(onRun.stderr).toContain('--event-map is only for diff');
}, 240_000);
