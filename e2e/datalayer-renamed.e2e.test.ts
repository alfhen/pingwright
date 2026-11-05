import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, runCli, scenario, site } from './cli-helpers.ts';

const testOrigin = () => ({ TAGREEVE_TEST_GTM_ORIGIN: site.containerUrl });

// The fixture container pushes one consent default and the page pushes two events, all to myLayer.
const PUSHES = 3;

async function runWith(optionLine: string) {
  const text = (await readFile(scenario('datalayer-renamed'), 'utf8')).replace(/^options:.*$/m, optionLine);
  const file = join(outDir, `renamed-${Math.random().toString(36).slice(2)}.yml`);
  await writeFile(file, text);
  return runCli(['run', file, '--site', site.url, '--out', outDir, '--json'], testOrigin());
}

const counted = (urls: string[]) => urls.flatMap((u) => (u.includes('/datalayer-renamed-count?') ? [new URL(u).searchParams.get('n')] : []));

test('with dataLayerNames the pushes to the named layer are recorded with its name', async () => {
  const r = await runCli(['run', scenario('datalayer-renamed'), '--site', site.url, '--out', outDir, '--json'], testOrigin());
  expect(r.code).not.toBe(2);
  const { dataLayerEvents, flags, requests } = r.records!;
  expect(counted(requests.map((q) => q.url))).toEqual([String(PUSHES)]);
  expect(dataLayerEvents).toHaveLength(PUSHES);
  expect(dataLayerEvents.every((e) => e.layer === 'myLayer')).toBe(true);
  expect(dataLayerEvents.map((e) => e.event)).toContain('renamed_one');
  expect(dataLayerEvents.map((e) => e.event)).toContain('renamed_two');
  expect(flags.filter((f) => f.kind === 'dataLayerNotHooked')).toEqual([]);
}, 90_000);

test('without the option nothing is recorded and one flag names the option', async () => {
  const r = await runWith('options: { seed: 1, allowUnknownDestination: true }');
  expect(r.code).not.toBe(2);
  const { dataLayerEvents, flags, requests } = r.records!;
  expect(counted(requests.map((q) => q.url))).toEqual([String(PUSHES)]);
  expect(dataLayerEvents).toEqual([]);
  const notHooked = flags.filter((f) => f.kind === 'dataLayerNotHooked');
  expect(notHooked).toHaveLength(1);
  expect(notHooked[0]!.detail).toContain('options.dataLayerNames');
  expect(notHooked[0]!.detail).toContain('"myLayer"');
}, 90_000);
