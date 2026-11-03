import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Workflow {
  on: { push: { tags: string[] } };
  permissions?: Record<string, string> | string;
  jobs: Record<string, { permissions?: Record<string, string> | string; uses?: string; steps?: { run?: string; uses?: string }[] }>;
}

const path = new URL('../.github/workflows/release-tag.yml', import.meta.url);
const text = readFileSync(path, 'utf8');
const workflow = parse(text) as Workflow;

const runLinesOf = (wf: Workflow): string[] =>
  Object.values(wf.jobs)
    .flatMap((job) => job.steps ?? [])
    .flatMap((step) => (step.run ?? '').replace(/\\\r?\n/g, '').split(/\n|&&|\|\||;|\|/));

const runLines = runLinesOf(workflow);

const isReadOnly = (permissions: Record<string, string> | string | undefined): boolean =>
  permissions === undefined ||
  permissions === 'read-all' ||
  (typeof permissions === 'object' && Object.values(permissions).every((level) => level !== 'write'));

export function workflowProblems(source: string): string[] {
  const wf = parse(source) as Workflow;
  const problems: string[] = [];
  if (!isReadOnly(wf.permissions)) problems.push('top-level permissions are not read-only');
  for (const [name, job] of Object.entries(wf.jobs)) {
    if (!isReadOnly(job.permissions)) problems.push(`job ${name} permissions are not read-only`);
    const uses = [job.uses, ...(job.steps ?? []).map((step) => step.uses)];
    for (const use of uses) {
      if (use && /publish|release/i.test(use)) problems.push(`uses ${use}`);
    }
  }
  if (/github\.token/i.test(source)) problems.push('github.token');
  const lines = runLinesOf(wf);
  const publishes = lines.filter((line) => /\b(npm|pnpm|yarn)\b.*\bpublish\b/.test(line));
  for (const line of publishes) {
    if (!line.includes('--dry-run')) problems.push(`publish without --dry-run: ${line.trim()}`);
    if (!line.includes('--tag "$dist_tag"')) problems.push(`publish without --tag "$dist_tag": ${line.trim()}`);
  }
  for (const line of lines) {
    if (/docker\s+(push|login)\b/.test(line) || (/\bbuild\b/.test(line) && /--push\b/.test(line))) {
      problems.push(`docker publish: ${line.trim()}`);
    }
  }
  return problems;
}

const base = (extra: string, perms = 'permissions:\n  contents: read\n') =>
  `name: x\non:\n  push:\n    tags: ['v*']\n${perms}jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n${extra}`;

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
    const publishes = runLines.filter((line) => /(npm|pnpm|yarn)\s+publish/.test(line));
    expect(publishes.length).toBeGreaterThan(0);
    for (const line of publishes) expect(line).toContain('--dry-run');
  });

  it('chooses next for release candidates and latest otherwise', () => {
    expect(text).toMatch(/v\*-rc\.\*\) dist_tag=next/);
    expect(text).toMatch(/\*\) dist_tag=latest/);
  });

  it('passes every rule', () => {
    expect(workflowProblems(text)).toEqual([]);
  });
});

describe('workflow rules', () => {
  const good = '      - run: npm publish --dry-run --tag "$dist_tag"\n';

  it('accepts a clean workflow', () => {
    expect(workflowProblems(base(good))).toEqual([]);
  });

  it('fails a job with write permissions', () => {
    const wf = `${base(good)}  b:\n    runs-on: ubuntu-24.04\n    permissions:\n      contents: write\n    steps:\n${good}`;
    expect(workflowProblems(wf)).toEqual(['job b permissions are not read-only']);
  });

  it('fails write-all on a job', () => {
    const wf = `${base(good)}  b:\n    runs-on: ubuntu-24.04\n    permissions: write-all\n    steps:\n${good}`;
    expect(workflowProblems(wf)).toHaveLength(1);
  });

  it('fails write permissions at the top level', () => {
    expect(workflowProblems(base(good, 'permissions:\n  contents: write\n'))).toEqual(['top-level permissions are not read-only']);
  });

  it.each(['npm', 'pnpm', 'yarn'])('fails %s publish without --dry-run', (tool) => {
    const problems = workflowProblems(base(`      - run: ${tool} publish --tag "$dist_tag"\n`));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without --dry-run');
  });

  it('fails a publish after other words on the line', () => {
    expect(workflowProblems(base('      - run: cd x && pnpm -r publish --tag "$dist_tag"\n'))).toHaveLength(1);
  });

  it('fails a uses value that publishes or releases', () => {
    expect(workflowProblems(base(`${good}      - uses: softprops/action-gh-release@v2\n`))).toEqual(['uses softprops/action-gh-release@v2']);
    expect(workflowProblems(base(`${good}      - uses: JS-DevTools/npm-publish@v3\n`))).toEqual(['uses JS-DevTools/npm-publish@v3']);
  });

  it('accepts read-all at the top level and on a job', () => {
    expect(workflowProblems(base(good, 'permissions: read-all\n'))).toEqual([]);
    const wf = `${base(good)}  b:\n    runs-on: ubuntu-24.04\n    permissions: read-all\n    steps:\n${good}`;
    expect(workflowProblems(wf)).toEqual([]);
  });

  it('fails write-all at the top level', () => {
    expect(workflowProblems(base(good, 'permissions: write-all\n'))).toEqual(['top-level permissions are not read-only']);
  });

  it('does not crash on a reusable-workflow job', () => {
    const wf = `${base(good)}  b:\n    uses: ./.github/workflows/build.yml\n`;
    expect(workflowProblems(wf)).toEqual([]);
  });

  it('checks the uses of a reusable-workflow job', () => {
    const wf = `${base(good)}  b:\n    uses: org/repo/.github/workflows/publish.yml@v1\n`;
    expect(workflowProblems(wf)).toEqual(['uses org/repo/.github/workflows/publish.yml@v1']);
  });

  it('joins backslash continuations before checking a publish', () => {
    const wf = base('      - run: |\n          npm publish \\\n            --tag "$dist_tag"\n');
    const problems = workflowProblems(wf);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without --dry-run');
  });

  it('accepts a continued publish that has the flags', () => {
    const wf = base('      - run: |\n          npm publish \\\n            --dry-run \\\n            --tag "$dist_tag"\n');
    expect(workflowProblems(wf)).toEqual([]);
  });

  it('does not join a command after a blank line to a trailing backslash', () => {
    const wf = base('      - run: |\n          npm publish --tag "$dist_tag" \\\n\n          echo --dry-run\n');
    const problems = workflowProblems(wf);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without --dry-run');
  });

  it('does not take --dry-run from a later command joined by a continuation', () => {
    const wf = base('      - run: |\n          npm publish --tag "$dist_tag" \\\n            && echo --dry-run\n');
    const problems = workflowProblems(wf);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('without --dry-run');
  });

  it('keeps a token split by a continuation whole', () => {
    const wf = base(`${good}      - run: |\n          docker pu\\\n          sh ghcr.io/x/y\n`);
    expect(workflowProblems(wf)).toHaveLength(1);
  });

  it('fails github.token', () => {
    expect(workflowProblems(base(`${good}      - run: echo \${{ github.token }}\n`))).toEqual(['github.token']);
  });

  it('fails a publish line without the dist tag', () => {
    const problems = workflowProblems(base('      - run: npm publish --dry-run\n'));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('--tag "$dist_tag"');
  });

  it.each(['docker push ghcr.io/x/y', 'docker login ghcr.io', 'docker buildx build --push .', 'docker build --push .'])('fails %s', (line) => {
    const problems = workflowProblems(base(`${good}      - run: ${line}\n`));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('docker publish');
  });

  it('lets a plain docker build through', () => {
    expect(workflowProblems(base(`${good}      - run: docker build -t x .\n`))).toEqual([]);
  });
});
