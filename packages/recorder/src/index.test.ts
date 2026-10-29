import { expect, test } from 'vitest';
import { COLLECTOR_ORIGIN } from './index.ts';

test('collector origin is the reserved .invalid host over https', () => {
  const url = new URL(COLLECTOR_ORIGIN);
  expect(url.hostname).toBe('collector.pingwright.invalid');
  expect(url.protocol).toBe('https:');
});
