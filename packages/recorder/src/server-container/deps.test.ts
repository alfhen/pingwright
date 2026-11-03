import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readJson(relative: string): { dependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
}

describe('certificate package', () => {
  it('is in the root dependencies at an exact version', () => {
    const version = readJson('../../../../package.json').dependencies?.['node-forge'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is in the recorder dependencies at the same version', () => {
    const root = readJson('../../../../package.json').dependencies?.['node-forge'];
    expect(readJson('../../package.json').dependencies?.['node-forge']).toBe(root);
  });
});
