import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const path = new URL('../.github/workflows/release-tag.yml', import.meta.url);
const text = readFileSync(path, 'utf8');
const workflow = parse(text) as {
  on: { push: { tags: string[] } };
  permissions: Record<string, string>;
  jobs: Record<string, { steps: { run?: string }[] }>;
};
const runLines = Object.values(workflow.jobs)
  .flatMap((job) => job.steps)
  .flatMap((step) => (step.run ?? '').split('\n'));

describe('release-tag workflow', () => {
  it('runs on pushed v tags only', () => {
    expect(workflow.on.push.tags).toEqual(['v*']);
    expect(Object.keys(workflow.on)).toEqual(['push']);
  });

  it('has read-only permissions and no id-token', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/id-token/);
  });

  it('holds no secrets', () => {
    expect(text).not.toMatch(/secrets\./i);
    expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|GH_TOKEN|GITHUB_TOKEN/);
  });

  it('never creates a GitHub release', () => {
    expect(runLines.filter((line) => /gh\s+release/.test(line))).toEqual([]);
    expect(text).not.toMatch(/action-gh-release|create-release/);
  });

  it('only runs npm publish as a dry run', () => {
    const publishes = runLines.filter((line) => /(npm|pnpm)\s+publish/.test(line));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) expect(line).toContain('--dry-run');
  });

  it('chooses next for release candidates and latest otherwise', () => {
    expect(text).toMatch(/v\*-rc\.\*\) dist_tag=next/);
    expect(text).toMatch(/\*\) dist_tag=latest/);
  });
});
