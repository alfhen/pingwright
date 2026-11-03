import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('./probe-webkit.ts', import.meta.url));

test('an unknown browser name exits 2 with the usage line before a browser starts', () => {
  const result = spawnSync(process.execPath, [script, 'firefox'], { encoding: 'utf8' });
  expect(result.status).toBe(2);
  expect(result.stderr.trim()).toBe('Usage: node scripts/probe-webkit.ts [webkit|chromium]');
  expect(result.stdout).toBe('');
});
