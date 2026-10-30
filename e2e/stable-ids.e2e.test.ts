import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from '../fixtures/site/src/index.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = join(root, 'dist/cli.js');
const scenario = (name: string) => join(root, 'e2e/scenarios', `${name}.yml`);

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  execFileSync(process.execPath, [join(root, 'scripts/build.ts')], { cwd: root, stdio: 'inherit' });
  site = await startFixtureSite();
  const parent = join(root, 'test-results');
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'stable-ids-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

function runCli(name: string): Promise<{ real: { pass: boolean; message: string } | undefined }> {
  const args = ['run', scenario(name), '--site', site.url, '--out', outDir, '--json'];
  return new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { cwd: root }, (_error, stdout) => {
      let real;
      try {
        const summary = JSON.parse(stdout) as { results: { expectation: string; pass: boolean; message: string }[] };
        real = summary.results.find((r) => r.expectation === 'builtin: possibleRealData');
      } catch {
        // Not a JSON summary.
      }
      resolve({ real });
    });
  });
}

test('a stable hashed client ID under many keys and an hmac parameter pass possibleRealData', async () => {
  const r = await runCli('stable-ids');
  expect(r.real?.message).toContain('found none');
  expect(r.real?.pass).toBe(true);
}, 90_000);

test('a hashed non-identity email under external_id still fails possibleRealData', async () => {
  const r = await runCli('stable-ids-leak');
  expect(r.real?.pass).toBe(false);
  expect(r.real?.message).toContain('not from the run identity');
}, 90_000);
