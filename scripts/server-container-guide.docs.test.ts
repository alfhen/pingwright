import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseCli } from '../packages/cli/src/args.ts';
import { dist, root } from './docs-test-helpers.ts';

const guide = readFileSync(join(root, 'docs/guide/server-container.md'), 'utf8');

function tagreeveCommands(markdown: string): string[] {
  const commands: string[] = [];
  for (const block of markdown.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.replace(/\\\n/g, ' ').split('\n')) {
      if (line.trim().startsWith('tagreeve ')) commands.push(line.trim());
    }
  }
  return commands;
}

test('every tagreeve command in the guide parses', () => {
  const commands = tagreeveCommands(guide);
  expect(commands.length).toBeGreaterThan(1);
  for (const command of commands) {
    const argv = command.split(/\s+/).slice(1);
    expect(() => parseCli(argv), command).not.toThrow();
  }
});

test('the guide holds no long base64 string and no gtm_auth value', () => {
  expect(guide).not.toMatch(/[A-Za-z0-9+/=_-]{40,}/);
  expect(guide).not.toMatch(/gtm_auth=\S/);
});

test('the sidebar links to the built page', () => {
  const config = readFileSync(join(root, 'site/astro.config.mjs'), 'utf8');
  expect(config).toContain("link: '/docs/guide/server-container'");
  expect(existsSync(join(dist, 'docs/guide/server-container.html'))).toBe(true);
});
