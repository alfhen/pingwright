import { expect, test } from 'vitest';
import { rootVersion, run, runCli, scenario, site, UNKNOWN } from './cli-helpers.ts';

test('usage errors exit 2', async () => {
  expect((await runCli(['run'])).code).toBe(2);
  expect((await runCli(['run', scenario('undecided')])).stderr).toContain('--site is required');
  const undeclared = await runCli(['run', scenario('undecided'), '--site', site.url, '--var', 'nope=1']);
  expect(undeclared.code).toBe(2);
  expect(undeclared.stderr).toContain('not declared');
  expect((await runCli(['run', 'missing.yml', '--site', site.url])).code).toBe(2);
});

test('--version prints the root package version', async () => {
  const r = await runCli(['--version']);
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe(rootVersion);
});

test('a third-party IP host is still an unknownDestination failure', async () => {
  const r = await run('third-party-ip');
  expect(r.failed).toContain(UNKNOWN);
  const { flags, requests } = r.records!;
  const hosts = flags
    .filter((f) => f.kind === 'unknownDestination')
    .map((f) => new URL(requests.find((q) => q.id === f.recordIds[0])!.url).hostname);
  expect(hosts).toContain('127.0.0.1');
  expect(flags.some((f) => f.kind === 'firstPartySubdomain')).toBe(false);
}, 90_000);

test('firstPartyHosts turns those requests into firstPartySubdomain flags that do not fail', async () => {
  const r = await run('first-party-hosts');
  expect(r.failed).not.toContain(UNKNOWN);
  const { flags } = r.records!;
  expect(flags.some((f) => f.kind === 'unknownDestination')).toBe(false);
  expect(flags.some((f) => f.kind === 'firstPartySubdomain' && f.detail.includes('/unknown-pixel'))).toBe(true);
}, 90_000);

test('run --help prints the help of run', async () => {
  const r = await runCli(['run', '--help']);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('Usage: pingwright run <scenario.yml>');
});
