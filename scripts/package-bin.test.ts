import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('package.json has the tagreeve bin only', () => {
  const pkg = JSON.parse(read('package.json')) as { bin: Record<string, string> };
  expect(Object.keys(pkg.bin)).toEqual(['tagreeve']);
});

test('the build has one entry point', () => {
  const match = /entryPoints:\s*\{([^}]*)\}/.exec(read('scripts/build.ts'));
  expect(match).not.toBeNull();
  expect(match![1]!.split(',').filter((entry) => entry.trim())).toHaveLength(1);
});

test('the built CLI prints the web template in both forms', () => {
  execFileSync(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('./build.ts', import.meta.url))], { stdio: 'pipe' });
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const file = read('packages/recorder/src/gtm-templates/web-tag-reporter.tpl');
  expect(execFileSync(process.execPath, [cli, 'template', 'web'], { encoding: 'utf8' })).toBe(file);
  const json = JSON.parse(execFileSync(process.execPath, [cli, 'template', 'web', '--json'], { encoding: 'utf8' })) as { template: string; setup: { publish: boolean } };
  expect(json.template).toBe(file);
  expect(json.setup.publish).toBe(false);
}, 60_000);
