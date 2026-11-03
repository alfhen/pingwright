import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const BINARY = /\.(png|ico|woff2?)$/;

const wholeFiles = [/^brand\/site-handoff\//, /^docs\/plan-.*\.md$/, /^docs\/proposal-.*\.md$/, /^scripts\/no-old-name\.test\.ts$/];

const allowedLines: Record<string, RegExp> = {
  'README.md': /^> \*\*Pingwright is now Tagreeve/,
};

const changelogHistory = (text: string): number => {
  const lines = text.split('\n');
  const history = lines.findIndex((line) => line.startsWith('## 0.3.0'));
  return history < 0 ? lines.length : history;
};

export function oldNameHits(files: Record<string, string>): string[] {
  const hits: string[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (wholeFiles.some((pattern) => pattern.test(file))) continue;
    const lines = text.replaceAll('pingwrightVersion', '').split('\n');
    const from = file === 'CHANGELOG.md' ? changelogHistory(text) : lines.length;
    const allowed = allowedLines[file];
    lines.forEach((line, index) => {
      if (index >= from || !/pingwright/i.test(line) || allowed?.test(line)) return;
      if (file === 'CHANGELOG.md' && inRenameBlock(text, index)) return;
      hits.push(`${file}:${index + 1}`);
    });
  }
  return hits;
}

function inRenameBlock(text: string, index: number): boolean {
  const lines = text.split('\n');
  const start = lines.indexOf('### Pingwright is now Tagreeve');
  if (start < 0 || index < start) return false;
  const next = lines.findIndex((line, i) => i > start && /^##+ /.test(line));
  return next < 0 || index < next;
}

test('no tracked file names the old product, outside the allowlist', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => file && !BINARY.test(file));
  const files = Object.fromEntries(tracked.map((file) => [file, readFileSync(`${root}${file}`, 'utf8')]));
  expect(oldNameHits(files)).toEqual([]);
  expect(files['CHANGELOG.md']).toContain('### Pingwright is now Tagreeve');
});

test('a leftover Pingwright in a source file is reported', () => {
  const files = { 'packages/cli/src/summary.ts': "const title = 'Pingwright run';\n" };
  expect(oldNameHits(files)).toEqual(['packages/cli/src/summary.ts:1']);
});

test('any case of the old name is reported', () => {
  expect(oldNameHits({ 'docs/a.md': 'PINGWRIGHT_X and pingwright and @pingwright/core' })).toEqual(['docs/a.md:1']);
});

test('the allowlist lets the history, and the record key through', () => {
  const changelog = ['# Changelog', '', '## 0.4.0-rc.1', '', '### Pingwright is now Tagreeve', '', 'Run `npm uninstall -g pingwright`.', '', '### Added', '', 'x', '', '## 0.3.0', '', 'Pingwright 0.3'].join('\n');
  expect(
    oldNameHits({
      'CHANGELOG.md': changelog,
      'docs/plan-0.4.md': 'Pingwright',
      'packages/core/src/records.ts': 'pingwrightVersion: string;',
    }),
  ).toEqual([]);
});

test('a pingwright bin in package.json is reported', () => {
  expect(oldNameHits({ 'package.json': '    "pingwright": "dist/pingwright.js"' })).toEqual(['package.json:1']);
});

test('the old name in the 0.4.0-rc.1 notes outside the rename block is reported', () => {
  const changelog = ['## 0.4.0-rc.1', '', '### Pingwright is now Tagreeve', '', 'pingwright', '', '### Added', '', 'Pingwright new thing', '', '## 0.3.0', 'Pingwright'].join('\n');
  expect(oldNameHits({ 'CHANGELOG.md': changelog })).toEqual(['CHANGELOG.md:9']);
});

test('the old name in a bullet right after the rename block is reported when no heading follows', () => {
  const changelog = ['## 0.4.0-rc.1', '', '### Pingwright is now Tagreeve', '', 'pingwright', '', '### Changes', '', '- A Pingwright bullet. (#1)', '', '## 0.3.0', 'Pingwright'].join('\n');
  expect(oldNameHits({ 'CHANGELOG.md': changelog })).toEqual(['CHANGELOG.md:9']);
});
