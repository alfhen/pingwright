import { expect, test } from 'vitest';
import { run, runCli, scenario, site, outDir } from './cli-helpers.ts';

const mustRule = (results: { expectation: string; pass: boolean }[]) => results.find((r) => r.expectation.startsWith('must:'))!;

test('--net-log is refused in stub mode and no run starts', async () => {
  for (const extra of [[], ['--network', 'stub']]) {
    const result = await runCli(['run', scenario('unload-beacons'), '--site', site.url, '--out', outDir, '--net-log', ...extra]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('--net-log needs --network live');
    expect(result.stderr).toContain('leave the machine');
    expect(result.records).toBeUndefined();
  }
});

test('the missing hit is reported as a gap in the summary', async () => {
  const { records } = await run('unload-beacons');
  expect(records!.requests.some((r) => r.captured === 'netlog')).toBe(false);
  expect(records!.hits.some((h) => h.event === 'add_to_cart')).toBe(false);
  expect(mustRule(records!.results).pass).toBe(false);
  const gap = records!.flags.filter((f) => f.kind === 'unloadGap');
  expect(gap).toHaveLength(1);
  expect(gap[0]!.detail).toContain('add_to_cart');
  expect(gap[0]!.detail).toContain('--net-log');
}, 90_000);
