import { expect, test } from 'vitest';
import { bestPageOffset, measurePageOffset, pageTimeToEpoch } from './clock.ts';

test('converts page times with a per-page offset', () => {
  const offset = measurePageOffset(1_800_000_000_500, 1_799_999_999_000);
  expect(offset).toBe(1500);
  expect(pageTimeToEpoch(1_799_999_999_250, offset)).toBe(1_800_000_000_750);
});

test('two pages with different origins land on the same clock', () => {
  const a = measurePageOffset(2000, 1000);
  const b = measurePageOffset(2000, 500);
  expect(pageTimeToEpoch(1000, a)).toBe(pageTimeToEpoch(500, b));
});

test('best offset uses the sample with the shortest round trip', () => {
  const offset = bestPageOffset([
    { before: 1000, page: 0, after: 1100 },
    { before: 2000, page: 1000, after: 2002 },
  ]);
  expect(offset).toBe(1001);
});

test('best offset needs a sample', () => {
  expect(() => bestPageOffset([])).toThrow();
});
