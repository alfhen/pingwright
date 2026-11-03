import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Markdown files under docs/ that are for maintainers and are never published. */
const unpublished = [/^docs\/goals\.md$/, /^docs\/release\.md$/, /^docs\/plan-[^/]*\.md$/, /^docs\/proposal-[^/]*\.md$/];

/** Repo-relative paths of the markdown pages the site publishes: the README and docs/**\/*.md, minus maintainer files. */
export function findPages(repoRoot: string): string[] {
  const docs = readdirSync(join(repoRoot, 'docs'), { recursive: true, encoding: 'utf8' })
    .map((path) => `docs/${path.split('\\').join('/')}`)
    .filter((path) => path.endsWith('.md') && !unpublished.some((pattern) => pattern.test(path)));
  return ['README.md', ...docs.sort()];
}

/** The content entry ID of a page, which is also its URL without the leading slash. */
export function pageId(repoPath: string): string {
  return repoPath === 'README.md' ? 'readme' : repoPath.replace(/\.md$/, '');
}

export function pageSource(id: string): string {
  return id === 'readme' ? 'README.md' : `${id}.md`;
}

/**
 * Splits off the page's first `# ` heading outside code fences, so the page shows one H1.
 * A page without one, such as the README with its raw `<h1>`, keeps its body and gets `fallback`.
 */
export function splitTitle(markdown: string, fallback: string): { title: string; body: string } {
  const lines = markdown.split('\n');
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? undefined : marker;
      continue;
    }
    if (fence) continue;
    const heading = /^# +(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      return { title: heading[1]!, body: [...lines.slice(0, index), ...lines.slice(index + 1)].join('\n') };
    }
  }
  return { title: fallback, body: markdown };
}
