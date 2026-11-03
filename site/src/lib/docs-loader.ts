import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Loader, LoaderContext } from 'astro/loaders';
import { findPages, pageId, splitTitle } from './docs-pages.ts';

/**
 * Reads the README and the docs from the repo root, where they also render on GitHub. The docs have no
 * front matter, so the title comes from each page's first `# ` heading.
 */
export function repoDocsLoader(): Loader {
  return {
    name: 'tagreeve-repo-docs',
    async load(context: LoaderContext) {
      const root = new URL('../', context.config.root);
      const loadAll = async () => {
        context.store.clear();
        for (const path of findPages(fileURLToPath(root))) {
          const fileURL = new URL(path, root);
          const source = readFileSync(fileURL, 'utf8');
          const { title, body } = splitTitle(source, path === 'README.md' ? 'README' : path);
          const id = pageId(path);
          context.store.set({
            id,
            data: await context.parseData({ id, data: { title } }),
            body,
            filePath: `../${path}`,
            digest: context.generateDigest(source),
            rendered: await context.renderMarkdown(body, { fileURL }),
          });
        }
      };
      await loadAll();
      const docs = fileURLToPath(new URL('docs/', root));
      const readme = fileURLToPath(new URL('README.md', root));
      context.watcher?.add([docs, readme]);
      context.watcher?.on('all', (_event, changed) => {
        if (changed === readme || (changed.startsWith(docs) && changed.endsWith('.md'))) void loadAll();
      });
    },
  };
}
