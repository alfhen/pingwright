import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const { build } = await import('esbuild');

// The root package does not depend on @tagreeve/*, so they are resolved from the sources.
const alias = Object.fromEntries(
  readdirSync(path('packages')).map((name) => [`@tagreeve/${name}`, path(`packages/${name}/src/index.ts`)]),
);

rmSync(path('dist'), { recursive: true, force: true });
await build({
  entryPoints: { cli: path('packages/cli/src/bin.ts') },
  outdir: path('dist'),
  splitting: true,
  chunkNames: '[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias,
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
});
mkdirSync(path('dist/rules'), { recursive: true });
cpSync(path('packages/consent/rules/fixture-site.json'), path('dist/rules/fixture-site.json'));
chmodSync(path('dist/cli.js'), 0o755);
