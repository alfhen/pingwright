import { readFileSync } from 'node:fs';
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
