import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import type MarkdownIt from 'markdown-it';
import { brandAssets } from './brand-assets.ts';
import { mermaidFences } from './mermaid.ts';
import { unlistedPages } from './page-guard.ts';

const repo = 'https://github.com/alfhen/pingwright';

// Links to repo files that are not pages go to GitHub, so dead link checks stay on for everything else.
function repoFileLinks(md: MarkdownIt) {
  const fallback = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]!;
    if (token.attrGet('href') === 'LICENSE') token.attrSet('href', `${repo}/blob/main/LICENSE`);
    return fallback ? fallback(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options);
  };
}

export default defineConfig({
  title: 'Pingwright',
  description: 'Agent-first testing for website tracking and consent.',
  lang: 'en',
  srcDir: '.',
  srcExclude: [
    '**/node_modules/**',
    '.claude/**',
    'packages/**',
    'fixtures/**',
    'e2e/**',
    'scripts/**',
    'brand/**',
    'dist/**',
    'runs/**',
    'test-results/**',
    'coverage/**',
    'AGENTS.md',
    'CLAUDE.md',
    'docs/plan-*.md',
    'docs/proposal-*.md',
  ],
  rewrites: { 'docs/index.md': 'index.md', 'README.md': 'readme.md' },
  cleanUrls: true,
  ignoreDeadLinks: false,
  useWebFonts: false,
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico', sizes: '16x16 32x32' }],
    ['link', { rel: 'icon', href: '/favicon-16.svg', type: 'image/svg+xml', sizes: '16x16' }],
    ['link', { rel: 'icon', href: '/favicon-32.svg', type: 'image/svg+xml', sizes: '32x32' }],
  ],
  vite: {
    publicDir: false,
    plugins: [brandAssets()],
    // The README refers to its lockup images as brand/*.svg.
    resolve: { alias: [{ find: /^brand\//, replacement: fileURLToPath(new URL('../brand/', import.meta.url)) }] },
  },
  markdown: {
    config(md) {
      repoFileLinks(md);
      mermaidFences(md);
    },
  },
  buildEnd(siteConfig) {
    const extra = unlistedPages(siteConfig.pages);
    if (extra.length) throw new Error(`Pages not in the published list: ${extra.join(', ')}`);
  },
  themeConfig: {
    logo: { light: '/mark.svg', dark: '/mark-dark.svg', alt: 'Pingwright' },
    nav: [
      { text: 'Guides', link: '/docs/guide/what-it-checks', activeMatch: '/docs/guide/' },
      { text: 'CLI', link: '/docs/cli' },
      { text: 'GitHub', link: repo },
    ],
    sidebar: [
      { text: 'Home', link: '/' },
      {
        text: 'Guides',
        items: [
          { text: 'What Pingwright checks', link: '/docs/guide/what-it-checks' },
          { text: 'Your first run', link: '/docs/guide/first-run' },
          { text: "Reading a run's results", link: '/docs/guide/reading-results' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'README', link: '/readme' },
          { text: 'CLI', link: '/docs/cli' },
          { text: 'Shopify checkout', link: '/docs/shopify-checkout' },
          { text: 'Design', link: '/docs/design' },
          { text: 'Releasing', link: '/docs/release' },
        ],
      },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
  },
});
