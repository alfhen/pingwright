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

async function netLogRun(options: string, extra: Partial<RunArgs>) {
  const dir = await mkdtemp(join(tmpdir(), 'pw-run-'));
  const scenario = join(dir, 's.yaml');
  await writeFile(scenario, `start: /\n${options}steps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n`);
  const err: string[] = [];
  const args = { scenario, vars: {}, out: dir, netLog: true, gtmOverride: join(dir, 'missing.json'), ...extra } as unknown as RunArgs;
  const code = await runCommand(args, { stdout: () => undefined, stderr: (t) => err.push(t) });
  return { code, err: err.join('') };
}

test('--net-log is refused when the scenario runs in stub mode', async () => {
  const { code, err } = await netLogRun('', {});
  expect(code).toBe(2);
  expect(err).toContain('--net-log needs --network live');
});

test('--net-log is refused when --network stub overrides a live scenario', async () => {
  const { code, err } = await netLogRun('options:\n  network: live\n', { network: 'stub' });
  expect(code).toBe(2);
  expect(err).toContain('--net-log needs --network live');
});

test('--net-log is accepted when the scenario sets network: live', async () => {
  const { err } = await netLogRun('options:\n  network: live\n', {});
  expect(err).not.toContain('--net-log needs --network live');
  expect(err).toContain('live mode');
});
