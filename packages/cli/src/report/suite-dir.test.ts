import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { main } from '../main.ts';
import type { SuiteManifest } from '../suite.ts';

const manifest: SuiteManifest = {
  suiteSchemaVersion: 1,
  id: 'suite_b',
  startedAt: 1_800_000_000_000,
  site: 'https://shop.example.com',
  variants: ['published', 'workspace'],
  cells: [],
  diffs: [],
  stores: [],
  exitCode: 0,
};

test('a suite folder with a child that has no suite.json next to a valid child reports the valid one', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pw-suite-dir-'));
  try {
    await mkdir(join(parent, 'suite_a'));
    await mkdir(join(parent, 'suite_b'));
    await writeFile(join(parent, 'suite_b', 'suite.json'), JSON.stringify(manifest));
    const err: string[] = [];
    const out = join(parent, 'out.html');
    const code = await main(['report', parent, '--html', out], { stdout: () => undefined, stderr: (t: string) => void err.push(t) });
    expect(code).toBe(0);
    expect(err.join('')).toContain('suite_b');
    expect(await readFile(out, 'utf8')).toContain('Tagreeve suite: published vs workspace on shop.example.com');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
