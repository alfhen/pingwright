import { expect, test } from 'vitest';
import { ga4, run, runCli, scenario, site, outDir } from './cli-helpers.ts';

test('--viewport 390x844 gives the mobile layout and records the size, with a desktop user agent', async () => {
  const r = await run('viewport', ['--viewport', '390x844']);
  expect(r.code, r.stderr).toBe(0);
  expect(ga4(r.records!.hits, 'layout_mobile')).toHaveLength(1);
  expect(ga4(r.records!.hits, 'layout_desktop')).toHaveLength(0);
  expect(r.records!.run.viewport).toEqual({ width: 390, height: 844 });
  const agents = r.records!.requests.map((q) => q.headers['user-agent']).filter((ua) => ua !== undefined);
  expect(agents.length).toBeGreaterThan(0);
  for (const ua of agents) expect(ua).not.toMatch(/HeadlessChrome|Mobile/);
  expect(r.records!.dataLayerEvents.some((e) => JSON.stringify(e.args).includes('ua_mobile'))).toBe(false);
}, 120_000);

test('a run without the flag gets the desktop layout and no Run.viewport', async () => {
  const r = await run('viewport');
  expect(r.code, r.stderr).toBe(0);
  expect(r.failed).toEqual([]);
  expect(ga4(r.records!.hits, 'layout_desktop')).toHaveLength(1);
  expect(r.records!.run).not.toHaveProperty('viewport');
}, 120_000);

test('options.viewport sets the size and --viewport wins over it', async () => {
  const fromScenario = await run('viewport-option');
  expect(fromScenario.code, fromScenario.stderr).toBe(0);
  expect(fromScenario.records!.run.viewport).toEqual({ width: 390, height: 844 });
  const flagWins = await run('viewport-option', ['--viewport', '1280x720']);
  expect(flagWins.records!.run.viewport).toEqual({ width: 1280, height: 720 });
  expect(ga4(flagWins.records!.hits, 'layout_desktop')).toHaveLength(1);
  expect(ga4(flagWins.records!.hits, 'layout_mobile')).toHaveLength(0);
}, 180_000);

test.each(['mobile', '390', '100x100'])('--viewport %s exits 2 before the browser starts', async (value) => {
  const r = await runCli(['run', scenario('viewport'), '--site', site.url, '--out', outDir, '--json', '--viewport', value]);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('--viewport must be');
  expect(r.stderr).not.toContain('Usage:');
  expect(r.stderr.trimEnd().split('\n').length).toBeLessThan(3);
  expect(r.records).toBeUndefined();
});
