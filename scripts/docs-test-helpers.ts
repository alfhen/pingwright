import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { chromeUserAgent } from '../packages/recorder/src/user-agent.ts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const dist = join(root, 'site/dist');
export const astro = join(root, 'node_modules/astro/bin/astro.mjs');
export const docsPort = 4173;
export const docsUrl = `http://127.0.0.1:${docsPort}`;
// Vitest sets NODE_ENV=test, which makes Astro build a dev site: no search index, dev-only markup.
export const astroEnv = { ...process.env, NODE_ENV: 'production', ASTRO_TELEMETRY_DISABLED: '1' };

/** Runs what `pnpm docs:build` runs: the Astro build, then the check of the output. */
export function buildDocs(outDir = dist): SpawnSyncReturns<string> {
  const build = spawnSync(process.execPath, [astro, 'build', '--root', 'site', '--outDir', outDir], { cwd: root, env: astroEnv, encoding: 'utf8' });
  if (build.status !== 0) return build;
  const check = spawnSync(process.execPath, [join(root, 'scripts/check-docs-dist.ts'), outDir], { cwd: root, encoding: 'utf8' });
  return { ...check, stdout: build.stdout + check.stdout, stderr: build.stderr + check.stderr };
}

/**
 * A browser context for the docs tests. The first-visit intro covers `/` in a fresh context, so every docs
 * test except the intro's own marks the intro as seen before any page script runs.
 */
export async function newDocsContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()), ...options });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('tagreeve.introSeen', '1');
    } catch {
      // Pages without storage, such as about:blank, do not show the intro either.
    }
  });
  return context;
}
