import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseCli } from '../packages/cli/src/args.ts';
import { dist, root } from './docs-test-helpers.ts';

const guide = readFileSync(join(root, 'docs/guide/server-container.md'), 'utf8');

function tagreeveCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.replace(/\\\n/g, ' ').split('\n')) {
      if (line.trim().startsWith('tagreeve ')) commands.push(line.trim());
    }
  }
  return commands;
}

const base64Like = /[A-Za-z0-9+/=_-]{40,}/;
const gtmAuthValue = /gtm_auth=\S/;
const fakeConfig = 'ZmFrZS1jb25maWctZm9yLXRlc3Rz'.repeat(2);
const planted = `${guide}\nconfig ${fakeConfig}\nhttps://example.test/?gtm_auth=FAKEAUTH0001\n`;

test('every tagreeve command in the guide parses', () => {
  const commands = tagreeveCommands(guide);
  expect(commands.length).toBeGreaterThan(1);
  expect(commands.some((c) => c.includes('--server-container-config'))).toBe(true);
  for (const command of commands) {
    const argv = command.split(/\s+/).slice(1);
    expect(() => parseCli(argv), command).not.toThrow();
  }
});

test('the guide holds no long base64 string and no gtm_auth value', () => {
  expect(guide).not.toMatch(base64Like);
  expect(guide).not.toMatch(gtmAuthValue);
});

test('the secret checks fail on a copy with a planted fake config and gtm_auth value', () => {
  expect(planted).toMatch(base64Like);
  expect(planted).toMatch(gtmAuthValue);
});

test('the config file is saved outside the working directory', () => {
  const runs = tagreeveCommands(guide).filter((c) => c.includes('--server-container-config'));
  expect(runs.length).toBeGreaterThan(0);
  for (const run of runs) expect(run).toMatch(/--server-container-config ~\//);
});

test('the guide explains the workspace preview config with placeholders only', () => {
  expect(guide).toContain('## Test an unpublished workspace');
  expect(guide).toContain('preview environment');
  expect(guide).toContain('quick preview');
  expect(guide.match(/id=GTM-PWTEST1&env=<env id>&auth=<auth>/g)?.length).toBe(2);
  for (const id of guide.match(/\bGTM-[A-Z0-9]+/g) ?? []) expect(id).toBe('GTM-PWTEST1');
});

test('the sidebar links to the built page', () => {
  const config = readFileSync(join(root, 'site/astro.config.mjs'), 'utf8');
  expect(config).toContain("link: '/docs/guide/server-container'");
  expect(existsSync(join(dist, 'docs/guide/server-container.html'))).toBe(true);
});
