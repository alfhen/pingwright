import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const blocks = [...readme.matchAll(/^( *)```yaml\n([\s\S]*?)^ *```/gm)].map(([, indent, body]) =>
  body!.replace(new RegExp(`^${indent}`, 'gm'), ''),
);
if (blocks.length < 2) throw new Error('README.md needs the scenario and quick start yaml blocks');

export const README_SCENARIO: string = blocks[0]!;
export const README_QUICKSTART_SCENARIO: string = blocks[1]!;
