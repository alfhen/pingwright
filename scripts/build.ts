import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
};

const { build } = await import('esbuild');

// The root package does not depend on @pingwright/*, so they are resolved from the sources.
const alias = Object.fromEntries(
  readdirSync(path('packages')).map((name) => [`@pingwright/${name}`, path(`packages/${name}/src/index.ts`)]),
);

rmSync(path('dist'), { recursive: true, force: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias,
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
} as const;
await build({ ...common, entryPoints: [path('packages/cli/src/bin.ts')], outfile: path('dist/cli.js') });
await build({ ...common, entryPoints: [path('packages/mcp/src/bin.ts')], outfile: path('dist/mcp.js') });
mkdirSync(path('dist/rules'), { recursive: true });
cpSync(path('packages/consent/rules/fixture-site.json'), path('dist/rules/fixture-site.json'));
chmodSync(path('dist/cli.js'), 0o755);
chmodSync(path('dist/mcp.js'), 0o755);
