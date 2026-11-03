import { expect, test } from 'vitest';
import { main } from './main.ts';

async function runMain(argv: string[]) {
  let stderr = '';
  let stdout = '';
  const code = await main(argv, { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) });
  return { code, stderr, stdout };
}

test.each([
  [['run', 's.yml', '--site', 'http://127.0.0.1:1', '--bogus'], 'Unknown option', 'tagreeve run --help'],
  [['run', 's.yml'], '--site is required', 'tagreeve run --help'],
  [['run', 's.yml', '--site', 'http://127.0.0.1:1', '--viewport', 'mobile'], '--viewport must be', 'tagreeve run --help'],
  [['diff', 'a.jsonl'], 'diff takes two JSONL files', 'tagreeve diff --help'],
  [['nope'], 'Unknown command', 'tagreeve --help'],
])('usage error for %j is short', async (argv, message, hint) => {
  const r = await runMain(argv);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(message);
  expect(r.stderr).toContain(hint);
  expect(r.stderr).not.toContain('Usage:');
  expect(r.stderr.trimEnd().split('\n').length).toBeLessThan(3);
  expect(r.stdout).toBe('');
});

test('--help still prints the full text', async () => {
  const r = await runMain(['--help']);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('tagreeve install-browser');
});

test('--help lists server-container build', async () => {
  const r = await runMain(['--help']);
  expect(r.stdout).toContain('tagreeve server-container build');
});

test('server-container without a subcommand is a short usage error', async () => {
  const r = await runMain(['server-container']);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('tagreeve server-container --help');
});
