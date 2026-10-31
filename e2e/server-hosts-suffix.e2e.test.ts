import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { outDir, runCli, site } from './cli-helpers.ts';

async function run(serverHosts: string): Promise<Awaited<ReturnType<typeof runCli>>> {
  const file = join(outDir, `hosts-${Math.random().toString(36).slice(2)}.yml`);
  const body = `start: /products/fake-tee\nsteps:\n  - wait: 1s\nexpect:\n  must: []\noptions: { seed: 1, allowUnknownDestination: true, serverHosts: ${serverHosts} }\n`;
  await writeFile(file, body);
  return runCli(['run', file, '--site', site.url, '--out', outDir, '--json']);
}

test.each(['*.police.uk', '*.onrender.com', '*.uk.com', '*.wordpress.com'])('serverHosts %s is a scenario error and no browser opens', async (host) => {
  const r = await run(`["${host}"]`);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(host);
  expect(r.stderr).toContain('public suffix');
  expect(r.records).toBeUndefined();
}, 30_000);

test('serverHosts *.abc.de is accepted and the run starts', async () => {
  const r = await run('["*.abc.de"]');
  expect(r.stderr).not.toContain('public suffix');
  expect(r.records).toBeDefined();
}, 90_000);
