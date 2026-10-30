import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { isLibraryLoadPath } from './library.ts';
import { readVersion } from './version.ts';

test('the version is the root package.json version', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8')) as { version: string };
  expect(readVersion()).toBe(pkg.version);
});

test('library loads are gtag.js, fbevents.js and the signals config', () => {
  for (const path of ['/gtag/js', '/tag/gtag/js', '/en_US/fbevents.js', '/signals/config/123']) expect(isLibraryLoadPath(path)).toBe(true);
  for (const path of ['/g/collect', '/tr', '/gtag/js/extra', '/xfbevents.js']) expect(isLibraryLoadPath(path)).toBe(false);
});
