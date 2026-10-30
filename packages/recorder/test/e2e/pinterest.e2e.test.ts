import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseScenario } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { recordScenario } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'pinterest-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const scenario = `start: /pinterest
steps:
  - wait: 4s
expect:
  mustNot:
    - { vendor: pinterest, before: consent }
    - { host: ct.pinterest.com, before: consent }
`;

test('Pinterest collection is stubbed, the library passes, and both mustNot rules fail', async () => {
  const parsed = parseScenario(scenario);
  const { records } = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed });

  const collection = records.requests.filter((r) => new URL(r.url).hostname === 'ct.pinterest.com');
  expect(collection.length).toBeGreaterThan(0);
  expect(collection.filter((r) => r.outcome !== 'stubbed')).toEqual([]);

  const core = records.requests.find((r) => r.url === 'https://s.pinimg.com/ct/core.js');
  expect(core?.outcome).toBe('passed');

  const events = records.hits.filter((h) => h.vendor === 'pinterest').map((h) => h.event);
  expect(events).toEqual(expect.arrayContaining(['init', 'pagevisit', 'addtocart', 'checkout']));

  const { run, truncatedAtLine, ...rest } = records;
  void truncatedAtLine;
  const results = evaluate([run, ...Object.values(rest).flat()], parsed);
  const ours = results.filter((r) => /pinterest/.test(r.expectation));
  expect(ours.map((r) => r.expectation)).toEqual([
    expect.stringContaining('vendor'),
    expect.stringContaining('host'),
  ]);
  expect(ours.map((r) => r.pass)).toEqual([false, false]);
  expect(ours.every((r) => r.evidence.length > 0)).toBe(true);
});
