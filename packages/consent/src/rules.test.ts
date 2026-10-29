import { expect, test } from 'vitest';
import { mergeRules } from './rules.ts';

test('an extra rule replaces the bundled rule with the same name', () => {
  const merged = mergeRules([{ name: 'a', mine: true }], [{ name: 'a' }, { name: 'b' }]);
  expect(merged).toEqual([{ name: 'a', mine: true }, { name: 'b' }]);
});

test('extra rules with new names are added', () => {
  expect(mergeRules([{ name: 'c' }], [{ name: 'a' }]).map((r) => r.name)).toEqual(['c', 'a']);
});
