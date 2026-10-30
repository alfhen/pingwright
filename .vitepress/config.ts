import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitepress';
import type MarkdownIt from 'markdown-it';
import { brandAssets } from './brand-assets.ts';
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

// A <picture> picks its source from the OS colour scheme, not the site's light/dark toggle,
// so on the site each one becomes a light and a dark <img> that brand.css shows by theme.
function themedPictures(md: MarkdownIt) {
  md.core.ruler.push('themed-pictures', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'html_block' || !token.content.includes('<picture>')) continue;
      token.content = token.content.replace(/<picture>([\s\S]*?)<\/picture>/g, (whole, inner: string) => {
        const dark = /<source[^>]*media="\(prefers-color-scheme: dark\)"[^>]*srcset="([^"]+)"/.exec(inner)?.[1];
        const img = /<img\b[^>]*>/.exec(inner)?.[0];
        if (!dark || !img) return whole;
        return `${img.replace('<img', '<img class="theme-light"')}${img
          .replace('<img', '<img class="theme-dark"')
          .replace(/src="[^"]+"/, `src="${dark}"`)}`;
      });
    }
  });
}

function markdownSetup(md: MarkdownIt) {
  repoFileLinks(md);
  themedPictures(md);
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
    'docs/release.md',
  ],
  rewrites: { 'README.md': 'index.md' },
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
  markdown: { config: markdownSetup },
  buildEnd(siteConfig) {
    const extra = unlistedPages(siteConfig.pages);
    if (extra.length) throw new Error(`Pages not in the published list: ${extra.join(', ')}`);
  },
  themeConfig: {
    logo: { light: '/mark.svg', dark: '/mark-dark.svg', alt: 'Pingwright' },
    nav: [{ text: 'GitHub', link: repo }],
    sidebar: [
      { text: 'Pingwright', link: '/' },
      { text: 'CLI', link: '/docs/cli' },
      { text: 'Shopify checkout', link: '/docs/shopify-checkout' },
      { text: 'Design', link: '/docs/design' },
    ],
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: repo }],
  },
});
