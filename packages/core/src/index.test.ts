import { expect, test } from 'vitest';
import { name } from './index.ts';

test('exports the package name', () => {
  expect(name).toBe('@pingwright/core');
});
