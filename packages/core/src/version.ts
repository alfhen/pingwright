import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The root package.json is one level above the bundle's dist/ and three above packages/core/src. */
export function readVersion(): string {
  for (const rel of ['../package.json', '../../../package.json']) {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { name?: string; version?: string };
    if (pkg.name === 'pingwright' && pkg.version) return pkg.version;
  }
  throw new Error('Cannot find the pingwright package.json');
}
