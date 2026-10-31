import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const installProblem = (text: string): string | undefined =>
  !/npm i -g pingwright(?![@\w-])/.test(text)
    ? 'does not give npm i -g pingwright as the install command'
    : /pingwright@next|-rc\./.test(text)
      ? 'mentions pingwright@next or an -rc. version'
      : undefined;

const installSection = (cli: string): string => cli.slice(cli.indexOf('## Install'), cli.indexOf('\n## ', cli.indexOf('## Install') + 1));

const enterAlwaysProblem = (text: string): string | undefined =>
  /Enter in the terminal always works/.test(text) ? 'says Enter always works' : undefined;

test('install text gives npm i -g pingwright and no pre-release', () => {
  expect(installProblem(read('README.md'))).toBeUndefined();
  expect(installProblem(read('docs/guide/first-run.md'))).toBeUndefined();
  expect(installProblem(installSection(read('docs/cli.md')))).toBeUndefined();
  expect(installProblem(read('.vitepress/theme/GetStartedPrompt.vue'))).toBeUndefined();
});

test('the install check fails on the rc text', () => {
  expect(installProblem('`npm i -g pingwright@next` installs the release candidate, `0.3.0-rc.2`.')).toBeDefined();
  expect(installProblem('Run `npm i -g pingwright`. The 0.3 sections need `pingwright@next`.')).toBeDefined();
  expect(installProblem('Run `npm i -g pingwright`, version `0.3.0-rc.2`.')).toBeDefined();
});

test('the docs do not say Enter always works', () => {
  expect(enterAlwaysProblem(read('docs/cli.md'))).toBeUndefined();
  expect(enterAlwaysProblem(read('docs/design.md'))).toBeUndefined();
  expect(enterAlwaysProblem('Enter in the terminal always works.')).toBeDefined();
});

test('the docs do not say a body rule hides the handoff pill', () => {
  expect(read('docs/cli.md')).not.toMatch(/rule such as `body \{ display: none \}`/);
});

test('the changelog has 0.3.0 above rc.2 and rc.1, with no leftover markers', () => {
  const log = read('CHANGELOG.md');
  const final = log.indexOf('## 0.3.0\n');
  const rc2 = log.indexOf('## 0.3.0-rc.2');
  const rc1 = log.indexOf('## 0.3.0-rc.1');
  expect(final).toBeGreaterThan(-1);
  expect(final).toBeLessThan(rc2);
  expect(rc2).toBeLessThan(rc1);
  expect(log).toContain('### Known in 0.3.0\n');
  expect(log).not.toMatch(/<!-- T\d+ -->/);
});

test('the version in the README and cli.md equals package.json', () => {
  const version = (JSON.parse(read('package.json')) as { version: string }).version;
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  for (const file of ['README.md', 'docs/cli.md']) {
    const named = read(file).match(/`\d+\.\d+\.\d+(?:-rc\.\d+)?`/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([`\`${version}\``]));
  }
});

test('design section 11 lists deniedIdentifiers as a built-in check', () => {
  expect(read('docs/design.md')).toMatch(/`options\.builtins` sets the severity[^\n]*`deniedIdentifiers`/);
});
