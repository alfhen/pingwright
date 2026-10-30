import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { RunArgs } from './args.ts';

const auth = 'pwfake-auth-0001';

vi.mock('@pingwright/expect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pingwright/expect')>()),
  evaluate: () => [
    { type: 'result', id: 'rsl_1', runId: 'run_1', expectation: `must ga4 ${auth}`, pass: false, evidence: [`https://x.example.com/?gtm_auth=${auth}`], message: `saw ${auth}` },
  ],
}));

vi.mock('@pingwright/recorder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@pingwright/recorder')>();
  return {
    ...actual,
    recordScenario: async (options: { outDir: string }) => {
      const { writeFile: write } = await import('node:fs/promises');
      const path = `${options.outDir}/run.jsonl`;
      await write(path, '');
      const records = {
        run: { type: 'run', id: 'run_1', scenario: 's.yml', gtmOverride: null },
        requests: [], steps: [], checkpoints: [], responses: [], hits: [], dataLayerEvents: [], consentEpochs: [],
        collectorReports: [], invalidReports: [], flags: [], results: [],
      };
      return { path, records };
    },
  };
});

const { runCommand } = await import('./run.ts');

test('result records, the summary and the output do not repeat the gtmAuth', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-scrub-'));
  const scenario = join(dir, 's.yml');
  const override = join(dir, 'override.json');
  await writeFile(scenario, 'start: /\nexpect:\n  must: []\n  mustNot: []\n');
  await writeFile(override, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: auth, gtmPreview: 'env-99' }));
  const out: string[] = [];
  const err: string[] = [];
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) };

  const withOverride = await runCommand({ scenario, out: dir, vars: {}, autoconsentRules: [], json: true, gtmOverride: override } as unknown as RunArgs, io);
  expect(err.join(''), 'stderr').toBe('');
  expect(withOverride).toBe(1);
  const record = await readFile(join(dir, 'run.jsonl'), 'utf8');
  expect(record).toContain('"type":"result"');
  expect(record).toContain('[redacted]');
  expect(record).not.toContain(auth);
  expect(out.join('')).not.toContain(auth);

  // Positive control: without an override the same result is written as is.
  await writeFile(join(dir, 'run.jsonl'), '');
  await runCommand({ scenario, out: dir, vars: {}, autoconsentRules: [], json: true } as unknown as RunArgs, io);
  expect(await readFile(join(dir, 'run.jsonl'), 'utf8')).toContain(auth);
});
