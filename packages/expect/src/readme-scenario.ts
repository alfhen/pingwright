import { readFileSync } from 'node:fs';

const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
const block = /```yaml\n([\s\S]*?)```/.exec(readme);
if (!block) throw new Error('README.md has no yaml block');

export const README_SCENARIO: string = block[1]!;
