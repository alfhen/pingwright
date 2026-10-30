import { expect, test } from 'vitest';
import { readVersion } from '@pingwright/core';
import { COLLECTOR_ORIGIN, PINGWRIGHT_VERSION, Recorder } from './index.ts';

test('collector origin is the reserved .invalid host over https', () => {
  const url = new URL(COLLECTOR_ORIGIN);
  expect(url.hostname).toBe('collector.pingwright.invalid');
  expect(url.protocol).toBe('https:');
});

test('the run record version is the root package.json version', () => {
  expect(PINGWRIGHT_VERSION).toBe(readVersion());
});

test('netLog is refused in stub mode before a browser starts', async () => {
  await expect(Recorder.launch({ networkMode: 'stub', outDir: 'unused', site: 'http://localhost:1', netLog: true })).rejects.toThrow(/networkMode "live"/);
});
