import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitepress';

const files: Record<string, string> = {
  '/favicon.ico': 'image/x-icon',
  '/favicon-16.svg': 'image/svg+xml',
  '/favicon-32.svg': 'image/svg+xml',
  '/mark.svg': 'image/svg+xml',
  '/mark-dark.svg': 'image/svg+xml',
};

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../brand${path}`, import.meta.url)));

// Serves the logo and favicons straight from brand/, so the files are never copied or edited.
export function brandAssets(): Plugin {
  return {
    name: 'pingwright-brand-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0] ?? '';
        const type = files[path];
        if (!type) return next();
        res.setHeader('content-type', type);
        res.end(read(path));
      });
    },
    generateBundle() {
      for (const path of Object.keys(files)) {
        this.emitFile({ type: 'asset', fileName: path.slice(1), source: read(path) });
      }
    },
  };
}
