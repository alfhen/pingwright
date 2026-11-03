import { readFileSync } from 'node:fs';
import type { ViteUserConfig } from 'astro';

type Plugin = Extract<NonNullable<ViteUserConfig['plugins']>[number], { name: string }>;

export const brandFiles: Record<string, string> = {
  '/favicon.ico': 'image/x-icon',
  '/favicon-16.svg': 'image/svg+xml',
  '/favicon-32.svg': 'image/svg+xml',
  '/mark.svg': 'image/svg+xml',
  '/mark-dark.svg': 'image/svg+xml',
  '/lockup.svg': 'image/svg+xml',
  '/lockup-dark.svg': 'image/svg+xml',
};

/** Serves the favicons, marks and lockups straight from brand/ at the site root, so they are never copied. */
export function brandAssets(brandDir: URL): Plugin {
  const read = (path: string) => readFileSync(new URL(path.slice(1), brandDir));
  return {
    name: 'tagreeve-brand-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const type = brandFiles[path];
        if (!type) return next();
        res.setHeader('content-type', type);
        res.end(read(path));
      });
    },
    generateBundle() {
      // Astro also runs a server build, whose output is thrown away. Only the client build lands in dist/.
      if (this.environment.name !== 'client') return;
      for (const path of Object.keys(brandFiles)) {
        this.emitFile({ type: 'asset', fileName: path.slice(1), source: read(path) });
      }
    },
  };
}
