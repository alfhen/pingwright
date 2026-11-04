import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { parseScenario } from '@tagreeve/expect';
import type { RunSpec } from './run.ts';

vi.mock('@tagreeve/recorder', async (importOriginal) => {
  const original = await importOriginal<typeof import('@tagreeve/recorder')>();
  return {
    ...original,
    recordScenario: async (options: { outDir: string }) => {
      const path = join(options.outDir, 'failed.jsonl');
      await writeFile(path, `${JSON.stringify({ type: 'run', id: 'run_1', scenario: 's' })}\n{"type":"step","id":"step_1"}\n`);
      const error = new original.StepError('visit-1', 'boom');
      error.run = { path } as typeof error.run;
      throw error;
    },
  };
});

const { executeRun } = await import('./run.ts');

async function failedRun(extra: Partial<RunSpec>) {
  const out = await mkdtemp(join(tmpdir(), 'pw-label-fail-'));
  const spec = {
    parsed: parseScenario('start: /\nsteps:\n  - visit: /\n'),
    scenarioName: 's',
    network: 'stub',
    site: 'http://localhost:3000',
    out,
    seed: undefined,
    headed: false,
    netLog: false,
    autoconsentRules: [],
    trackers: [],
    gtmOverride: undefined,
    ...extra,
  } as RunSpec;
  const outcome = await executeRun(spec, { stdout: () => undefined, stderr: () => undefined });
  const first = JSON.parse((await readFile(outcome.path!, 'utf8')).split('\n')[0]!) as Record<string, unknown>;
  return { outcome, first, out };
}

test('a failed run with --label and no variant writes the label on the run line', async () => {
  const { outcome, first, out } = await failedRun({ label: 'x' });
  expect(outcome.code).toBe(2);
  expect(outcome.path).toBe(join(out, 'failed.jsonl'));
  expect(first).toMatchObject({ id: 'run_1', label: 'x' });
  expect(first).not.toHaveProperty('variant');
});

test('a failed suite cell has its label, store and variant and is renamed', async () => {
  const { outcome, first, out } = await failedRun({ label: 'x', store: 'se', variant: { name: 'ws', fileStem: 'a.se' } });
  expect(outcome.path).toBe(join(out, 'a.se.ws.jsonl'));
  expect(first).toMatchObject({ label: 'x', store: 'se', variant: 'ws' });
});
