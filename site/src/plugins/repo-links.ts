import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineMdastPlugin, type MdastPluginEntry } from 'satteri';
import { pageId } from '../lib/docs-pages.ts';

/** Repo files that are not pages. Links to them go to GitHub. */
const onGitHub = new Set(['LICENSE', 'CHANGELOG.md']);

/**
 * Turns a relative link in a repo markdown file into a site URL: `../cli.md#x` becomes `/docs/cli#x`.
 * Links that point at nothing the site publishes keep a site URL, so the dead link check catches them.
 */
export function rewriteRepoLink(url: string, sourcePath: string, repo: string): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('/') || url.startsWith('#')) return url;
  const hashAt = url.indexOf('#');
  const path = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);
  if (!path) return url;
  const target = posix.normalize(posix.join(posix.dirname(sourcePath), decodeURI(path)));
  if (target.startsWith('../')) return url;
  if (onGitHub.has(target)) return `${repo}/blob/main/${target}${hash}`;
  if (target.endsWith('.md')) return `/${pageId(target)}${hash}`;
  return `/${target}${hash}`;
}

export function repoLinks({ root, repo }: { root: URL; repo: string }): MdastPluginEntry {
  const rootPath = fileURLToPath(root);
  return ({ fileURL }) => {
    const file = fileURL && fileURLToPath(fileURL);
    if (!file?.startsWith(rootPath)) return undefined;
    const source = posix.normalize(file.slice(rootPath.length).split('\\').join('/'));
    return defineMdastPlugin({
      name: 'tagreeve-repo-links',
      link: (node) => ({ ...node, url: rewriteRepoLink(node.url, source, repo) }),
      definition: (node) => ({ ...node, url: rewriteRepoLink(node.url, source, repo) }),
    });
  };
}
