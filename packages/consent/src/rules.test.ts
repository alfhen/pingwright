import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ConsentDriver } from './driver.ts';
import { mergeRules } from './rules.ts';

test('an extra rule replaces the bundled rule with the same name', () => {
  const merged = mergeRules([{ name: 'a', mine: true }], [{ name: 'a' }, { name: 'b' }]);
  expect(merged).toEqual([{ name: 'a', mine: true }, { name: 'b' }]);
});

test('extra rules with new names are added', () => {
  expect(mergeRules([{ name: 'c' }], [{ name: 'a' }]).map((r) => r.name)).toEqual(['c', 'a']);
});

test('the driver sends one rule per name when a rule file reuses a bundled name', () => {
  const ruleFiles = [fileURLToPath(new URL('../test/e2e/replacement-rule.json', import.meta.url))];
  const names = new ConsentDriver({ ruleFiles, fixtureRules: false }).ruleNames;
  expect(names.filter((n) => n === 'Cybotcookiebot')).toHaveLength(1);
  expect(new Set(names).size).toBe(names.length);
});
