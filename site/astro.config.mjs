import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import { satteri } from '@astrojs/markdown-satteri';
import tailwindcss from '@tailwindcss/vite';
import { annotatedSummary } from './src/plugins/annotated-summary.ts';
import { brandAssets } from './src/plugins/brand-assets.ts';
import { getStartedPrompt } from './src/plugins/get-started-prompt.ts';
import { mermaidFences } from './src/plugins/mermaid.ts';
import { noSidebarState } from './src/plugins/no-sidebar-state.ts';
import { pageGuard } from './src/plugins/page-guard.ts';
import { repoLinks } from './src/plugins/repo-links.ts';
import { themedPictures } from './src/plugins/themed-pictures.ts';

const repo = 'https://github.com/alfhen/tagreeve';
const repoRoot = new URL('../', import.meta.url);

const sidebar = [
  {
    label: 'guides',
    items: [
      { label: 'What Tagreeve checks', link: '/docs/guide/what-it-checks' },
      { label: 'Your first run', link: '/docs/guide/first-run' },
      { label: "Reading a run's results", link: '/docs/guide/reading-results' },
      { label: 'Run your server container locally', link: '/docs/guide/server-container' },
    ],
  },
  {
    label: 'reference',
    items: [
      { label: 'README', link: '/readme' },
      { label: 'CLI', link: '/docs/cli' },
      { label: 'Shopify checkout', link: '/docs/shopify-checkout' },
      { label: 'Design', link: '/docs/design' },
    ],
  },
];

export default defineConfig({
  site: 'https://tagreeve.dev',
  trailingSlash: 'never',
  build: { format: 'file' },
  markdown: {
    processor: satteri({
      features: { smartPunctuation: false },
      mdastPlugins: [repoLinks({ root: repoRoot, repo }), themedPictures, mermaidFences, annotatedSummary(), getStartedPrompt],
    }),
  },
  integrations: [
    starlight({
      title: 'Tagreeve',
      description: 'Agent-first testing for website tracking and consent.',
      favicon: '/favicon.ico',
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon-16.svg', type: 'image/svg+xml', sizes: '16x16' } },
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon-32.svg', type: 'image/svg+xml', sizes: '32x32' } },
      ],
      sidebar,
      tableOfContents: false,
      markdown: { processedDirs: ['..'] },
      expressiveCode: {
        themes: ['github-dark-default'],
        styleOverrides: {
          codeBackground: '#060807',
          codeForeground: '#D9E2DF',
          borderColor: 'var(--line)',
          borderRadius: '10px',
          codeFontFamily: "'Geist Mono', ui-monospace, monospace",
          uiFontFamily: "'Geist Mono', ui-monospace, monospace",
          frames: { shadowColor: 'transparent' },
        },
      },
      customCss: [
        '@fontsource/geist/400.css',
        '@fontsource/geist/500.css',
        '@fontsource/geist/600.css',
        '@fontsource/geist/700.css',
        '@fontsource/geist-mono/400.css',
        '@fontsource/geist-mono/500.css',
        '@fontsource/geist-mono/600.css',
        './src/styles/docs.css',
      ],
      components: {
        Header: './src/components/starlight/Header.astro',
        ThemeProvider: './src/components/starlight/ThemeProvider.astro',
        MobileMenuFooter: './src/components/starlight/MobileMenuFooter.astro',
        MobileMenuToggle: './src/components/starlight/MobileMenuToggle.astro',
        Sidebar: './src/components/starlight/Sidebar.astro',
        PageTitle: './src/components/starlight/PageTitle.astro',
        MarkdownContent: './src/components/docs/MarkdownContent.astro',
        Footer: './src/components/starlight/Footer.astro',
      },
    }),
    preact(),
    pageGuard(sidebar),
  ],
  vite: {
    plugins: [tailwindcss(), brandAssets(new URL('brand/', repoRoot)), noSidebarState()],
  },
});
