import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export type Rule = Record<string, unknown>;

// From source the file sits in ../rules; the bundle has it in ./rules next to dist/cli.js.
const bundledFixtureRules = fileURLToPath(new URL('./rules/fixture-site.json', import.meta.url));
export const fixtureRulesPath = existsSync(bundledFixtureRules)
  ? bundledFixtureRules
  : fileURLToPath(new URL('../rules/fixture-site.json', import.meta.url));

export function readRuleFile(path: string): Rule[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { autoconsent?: unknown } | null;
  if (!parsed || !Array.isArray(parsed.autoconsent)) {
    throw new Error(`Rule file ${path} must be a JSON object with an "autoconsent" array of rules`);
  }
  return parsed.autoconsent as Rule[];
}

export function bundledRules(): Rule[] {
  return (require('@duckduckgo/autoconsent/rules/rules.json') as { autoconsent: Rule[] }).autoconsent;
}

export function contentScriptSource(): string {
  const entry = require.resolve('@duckduckgo/autoconsent');
  return readFileSync(join(dirname(entry), 'autoconsent.playwright.js'), 'utf8');
}

/**
 * An extra rule replaces the bundled JSON rule of the same name; autoconsent itself ignores rule order.
 * Code-based CMPs (such as Cybotcookiebot) are not in the JSON and cannot be replaced by name: give
 * the rule another name and list the CMP in `disabledCmps`.
 */
export function mergeRules(extra: readonly Rule[], bundled: readonly Rule[]): Rule[] {
  const names = new Set(extra.map((rule) => rule.name));
  return [...extra, ...bundled.filter((rule) => !names.has(rule.name))];
}
