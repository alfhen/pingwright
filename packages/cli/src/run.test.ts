import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { RunArgs } from './args.ts';
import { runCommand } from './run.ts';

test('--var for an inherited name exits 2 as undeclared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-run-'));
  const scenario = join(dir, 's.yaml');
  await writeFile(scenario, 'start: /\nvars:\n  product: tee\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n');
  const err: string[] = [];
  const code = await runCommand({ scenario, vars: { constructor: '1' }, out: dir } as unknown as RunArgs, {
    stdout: () => undefined,
    stderr: (t) => err.push(t),
  });
  expect(err.join('')).toContain('--var constructor not declared');
  expect(code).toBe(2);
});
