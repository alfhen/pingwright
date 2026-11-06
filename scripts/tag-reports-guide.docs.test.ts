import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseCli } from '../packages/cli/src/args.ts';
import { dist, root } from './docs-test-helpers.ts';

const guide = readFileSync(join(root, 'docs/guide/tag-reports.md'), 'utf8');
const gtmAuthValue = /gtm_auth=\S/;
const authInJson = /"gtmAuth":\s*"(?!<auth>")[^"]+"/;
const longToken = /[A-Za-z0-9+/=_-]{40,}/;

function tagreeveCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split('\n')) if (line.trim().startsWith('tagreeve ')) commands.push(line.trim());
  }
  return commands;
}

function agentStepsOf(markdown: string): string {
  const start = markdown.indexOf('## Install the reporter with an agent');
  return markdown.slice(start, markdown.indexOf('## Install the reporter by hand'));
}

const successCheck = (steps: string): boolean =>
  steps.includes('`tags["GTM-PWTEST1"].reports`') && /must be greater than 0/.test(steps) && !/not empty|non-empty/i.test(steps.replace(/is still an entry[^.]*\./, ''));

test('the page is built and the sidebar links it', () => {
  const config = readFileSync(join(root, 'site/astro.config.mjs'), 'utf8');
  expect(config).toContain("link: '/docs/guide/tag-reports'");
  expect(existsSync(join(dist, 'docs/guide/tag-reports.html'))).toBe(true);
});

test('only GTM-PWTEST1 and placeholders appear, and no auth value', () => {
  for (const id of guide.match(/\bGTM-[A-Z0-9]+/g) ?? []) expect(id).toBe('GTM-PWTEST1');
  expect(guide).not.toMatch(gtmAuthValue);
  expect(guide).not.toMatch(authInJson);
  expect(guide).not.toMatch(longToken);
});

test('the secret checks fail on planted values', () => {
  expect(`${guide}\nhttps://example.test/?gtm_auth=FAKEAUTH0001`).toMatch(gtmAuthValue);
  expect(`${guide}\n{"gtmAuth": "FAKEAUTH0001"}`).toMatch(authInJson);
  expect(`${guide}\n{"gtmAuth": "<auth>"}`).not.toMatch(authInJson);
  expect(`${guide}\nGTM-PWNOVER`.match(/\bGTM-[A-Z0-9]+/g)).toContain('GTM-PWNOVER');
  expect(`${guide}\n${'ZmFrZS1jb25maWc'.repeat(3)}`).toMatch(longToken);
});

test('every tagreeve command in the guide parses', () => {
  const commands = tagreeveCommands(guide);
  expect(commands.some((c) => c.startsWith('tagreeve template web --json'))).toBe(true);
  expect(commands.some((c) => c.includes('--gtm-override'))).toBe(true);
  for (const command of commands) {
    const argv = command.split(/\s+/).slice(1);
    const redirect = argv.indexOf('>');
    expect(() => parseCli(redirect === -1 ? argv : argv.slice(0, redirect)), command).not.toThrow();
  }
});

test('the Mermaid block has a summary line under it', () => {
  const m = /```mermaid\n[\s\S]*?```\n\n([^\n]+)/.exec(guide);
  expect(m).not.toBeNull();
  expect(m![1]!.length).toBeGreaterThan(20);
  expect(m![1]!).not.toMatch(/^[`#|-]/);
});

test('the agent steps come first and judge the install by reports greater than 0', () => {
  const steps = agentStepsOf(guide);
  expect(guide.indexOf('## Install the reporter with an agent')).toBeLessThan(guide.indexOf('## Install the reporter by hand'));
  expect(steps).toContain('tagreeve template web --json');
  expect(steps).toContain('"reports": 0');
  expect(steps).toContain('Tags: no reports from GTM-PWTEST1');
  expect(steps).toMatch(/Do not publish the workspace version/);
  expect(successCheck(steps)).toBe(true);
});

test('the success check fails when the agent steps say "not empty"', () => {
  const steps = agentStepsOf(guide);
  expect(successCheck(steps.replace('must be greater than 0', 'must not be empty'))).toBe(false);
  expect(successCheck(`${steps}\nSuccess means the tags key is not empty.`)).toBe(false);
});

test('the guide says Tagreeve never calls the GTM API', () => {
  expect(guide).toContain('Tagreeve never calls the GTM API');
});

test('the guide gives the field facts, the file mode and the override file name', () => {
  expect(guide).toContain('QUICK_PREVIEW');
  expect(guide).not.toMatch(/Field checks have not confirmed this yet/);
  expect(guide).toContain('workspace-override.json');
  expect(guide).not.toContain('/override.json');
  expect(guide.match(/mode 0600/g)?.length).toBeGreaterThanOrEqual(2);
  expect(guide).toContain('./project-layout.md#what-stays-outside-the-repo');
});
