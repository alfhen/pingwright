import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const installProblem = (text: string): string | undefined =>
  /npm i -g tagreeve(?![@\w-])/.test(text)
    ? 'gives the bare npm i -g tagreeve as the install command'
    : !/npm i -g tagreeve@next(?![\w-])/.test(text)
      ? 'does not give npm i -g tagreeve@next as the install command'
      : /tagreeve[^.\n]*installs `0\.3\.0`/.test(text)
        ? 'says tagreeve installs 0.3.0'
        : undefined;

const installSection = (cli: string): string => cli.slice(cli.indexOf('## Install'), cli.indexOf('\n## ', cli.indexOf('## Install') + 1));

const enterAlwaysProblem = (text: string): string | undefined =>
  /Enter in the terminal always works/.test(text) ? 'says Enter always works' : undefined;

test('install text gives npm i -g tagreeve@next and no tagreeve 0.3.0', () => {
  expect(installProblem(read('README.md'))).toBeUndefined();
  expect(installProblem(read('docs/guide/first-run.md'))).toBeUndefined();
  expect(installProblem(installSection(read('docs/cli.md')))).toBeUndefined();
  expect(installProblem(read('site/src/lib/prompt.ts'))).toBeUndefined();
});

test('the install check fails on the bare command, a missing install line or a tagreeve 0.3.0 claim', () => {
  expect(installProblem('Run `npm i -g tagreeve`.')).toBeDefined();
  expect(installProblem('`npm i -g tagreeve` and `npm i -g tagreeve@next`.')).toBeDefined();
  expect(installProblem('Install tagreeve.')).toBeDefined();
  expect(installProblem('`npm i -g tagreeve@next` installs `0.3.0`.')).toBeDefined();
  expect(installProblem('Run `npm i -g tagreeve@next`.')).toBeUndefined();
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
  expect(log.slice(final, rc2)).not.toMatch(/<!-- T\d+ -->/);
});

test('the version in the README and cli.md equals package.json', () => {
  const version = (JSON.parse(read('package.json')) as { version: string }).version;
  expect(version).toMatch(/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/);
  for (const file of ['README.md', 'docs/cli.md']) {
    const named = read(file).match(/`\d+\.\d+\.\d+(?:-rc\.\d+)?`/g) ?? [];
    expect(named.length).toBeGreaterThan(0);
    expect(new Set(named)).toEqual(new Set([`\`${version}\``]));
  }
});

test('design section 11 lists deniedIdentifiers as a built-in check', () => {
  expect(read('docs/design.md')).toMatch(/`options\.builtins` sets the severity[^\n]*`deniedIdentifiers`/);
});

const loginRuleProblem = (agents: string, design: string): string | undefined => {
  const section13 = design.slice(design.indexOf('**Other rules**'), design.indexOf('## 14.'));
  return /Log-ins are never automated on a hosted site/.test(agents) && /Log-ins are handoff steps/.test(section13)
    ? undefined
    : 'AGENTS.md or design section 13 no longer says log-ins are handoff steps on a hosted site';
};

test('AGENTS.md and design section 13 say log-ins are handoff steps on a hosted site', () => {
  expect(loginRuleProblem(read('AGENTS.md'), read('docs/design.md'))).toBeUndefined();
  expect(loginRuleProblem('Payments are handoff steps.', '**Other rules**\n- Payments are handoffs.\n## 14.')).toBeDefined();
});
