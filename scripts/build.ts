import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const pkg = JSON.parse(readFileSync(path('package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

// `npm i -g github:...` runs prepare in a global-mode install that leaves devDependencies out, so esbuild may be missing.
async function loadEsbuild(): Promise<typeof import('esbuild')> {
  try {
    return await import('esbuild');
  } catch {
    const dir = mkdtempSync(join(tmpdir(), 'pingwright-esbuild-'));
    execFileSync('npm', ['install', '--prefix', dir, '--global=false', '--no-audit', '--no-fund', `esbuild@${pkg.devDependencies.esbuild}`], {
      stdio: 'inherit',
    });
    return createRequire(join(dir, 'x.js'))('esbuild');
  }
}

const { build } = await loadEsbuild();

// npm runs this without workspace symlinks, so @pingwright/* is resolved from the sources.
const alias = Object.fromEntries(
  readdirSync(path('packages')).map((name) => [`@pingwright/${name}`, path(`packages/${name}/src/index.ts`)]),
);

rmSync(path('dist'), { recursive: true, force: true });
await build({
  entryPoints: [path('packages/cli/src/bin.ts')],
  outfile: path('dist/cli.js'),
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
