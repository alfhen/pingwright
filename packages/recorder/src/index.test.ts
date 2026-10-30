import { expect, test } from 'vitest';
import { readVersion } from '@pingwright/core';
import { COLLECTOR_ORIGIN, PINGWRIGHT_VERSION } from './index.ts';

test('collector origin is the reserved .invalid host over https', () => {
  const url = new URL(COLLECTOR_ORIGIN);
  expect(url.hostname).toBe('collector.pingwright.invalid');
  expect(url.protocol).toBe('https:');
});

test('the run record version is the root package.json version', () => {
  expect(PINGWRIGHT_VERSION).toBe(readVersion());
});
