import { expect, test } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ConsentDriver } from './driver.ts';
import { bundledRules, mergeRules, readRuleFile } from './rules.ts';

test('an extra rule replaces the bundled rule with the same name', () => {
  const merged = mergeRules([{ name: 'a', mine: true }], [{ name: 'a' }, { name: 'b' }]);
  expect(merged).toEqual([{ name: 'a', mine: true }, { name: 'b' }]);
});

test('extra rules with new names are added', () => {
  expect(mergeRules([{ name: 'c' }], [{ name: 'a' }]).map((r) => r.name)).toEqual(['c', 'a']);
});

test('a rule file reusing the name of a bundled JSON rule replaces it', () => {
  const ruleFiles = [fileURLToPath(new URL('../test/e2e/replacement-rule.json', import.meta.url))];
  const [mine] = readRuleFile(ruleFiles[0]!);
  const bundled = bundledRules();
  expect(bundled.some((r) => r.name === mine!.name)).toBe(true);
  const merged = mergeRules([mine!], bundled);
  expect(merged.filter((r) => r.name === mine!.name)).toEqual([mine]);
  expect(merged).toHaveLength(bundled.length);
  const names = new ConsentDriver({ ruleFiles, fixtureRules: false }).ruleNames;
  expect(new Set(names).size).toBe(names.length);
});
