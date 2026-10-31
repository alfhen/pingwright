import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const readmeInstallProblem = (readme: string): string | undefined =>
  !/`npm i -g pingwright` installs 0\.2/.test(readme) || !/need the release candidate/.test(readme) || !readme.includes('pingwright@next')
    ? 'README does not say that plain install gives 0.2 and 0.3 sections need pingwright@next'
    : undefined;

const oldInstallLine = '`npm i -g pingwright@next` installs the release candidate, `0.3.0-rc.1`.';

const enterAlwaysProblem = (text: string): string | undefined =>
  /Enter in the terminal always works/.test(text) ? 'says Enter always works' : undefined;

test('the README tells readers the 0.3 sections need pingwright@next', () => {
  expect(readmeInstallProblem(read('README.md'))).toBeUndefined();
});

test('the README check fails on the old install line', () => {
  expect(readmeInstallProblem(`Node 22.18 or later. ${oldInstallLine} Other ways to install are in docs/cli.md.`)).toBeDefined();
});

test('the docs do not say Enter always works', () => {
  expect(enterAlwaysProblem(read('docs/cli.md'))).toBeUndefined();
  expect(enterAlwaysProblem(read('docs/design.md'))).toBeUndefined();
  expect(enterAlwaysProblem('Enter in the terminal always works.')).toBeDefined();
});

test('the docs do not say a body rule hides the handoff pill', () => {
  expect(read('docs/cli.md')).not.toMatch(/rule such as `body \{ display: none \}`/);
});

test('the changelog has an rc.2 section above rc.1 with the known-in-rc.1 list', () => {
  const log = read('CHANGELOG.md');
  const rc2 = log.indexOf('## 0.3.0-rc.2');
  const rc1 = log.indexOf('## 0.3.0-rc.1');
  expect(rc2).toBeGreaterThan(-1);
  expect(rc2).toBeLessThan(rc1);
  expect(log).toContain('Known in 0.3.0-rc.1');
});

test('design section 11 lists deniedIdentifiers as a built-in check', () => {
  expect(read('docs/design.md')).toMatch(/`options\.builtins` sets the severity[^\n]*`deniedIdentifiers`/);
});
