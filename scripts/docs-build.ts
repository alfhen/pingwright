import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const dist = join(root, 'site/dist');
export const astro = join(root, 'node_modules/astro/bin/astro.mjs');
// Vitest sets NODE_ENV=test, which makes Astro build a dev site: no search index, dev-only markup.
export const astroEnv = { ...process.env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1' };

/** Runs what `pnpm docs:build` runs: the Astro build, then the check of the output. */
export function buildDocs(outDir = dist): SpawnSyncReturns<string> {
  const build = spawnSync(process.execPath, [astro, 'build', '--root', 'site', '--outDir', outDir], { cwd: root, env: astroEnv, encoding: 'utf8' });
  if (build.status !== 0) return build;
  const check = spawnSync(process.execPath, [join(root, 'scripts/check-docs-dist.ts'), outDir], { cwd: root, encoding: 'utf8' });
  return { ...check, stdout: build.stdout + check.stdout, stderr: build.stderr + check.stderr };
}
