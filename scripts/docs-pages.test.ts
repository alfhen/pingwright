import { describe, expect, it } from 'vitest';
import { sidebarPages, unlistedPages } from '../.vitepress/page-guard.ts';

const rewrites = { 'docs/index.md': 'index.md', 'README.md': 'readme.md' };
const sidebar = [
  { text: 'Home', link: '/' },
  { text: 'Guides', items: [{ text: 'First run', link: '/docs/guide/first-run' }] },
  { text: 'Reference', items: [{ text: 'README', link: '/readme' }, { text: 'CLI', link: '/docs/cli' }] },
  { text: 'Elsewhere', link: 'https://example.com/' },
];

describe('sidebarPages', () => {
  it('maps sidebar links back to source pages', () => {
    expect(sidebarPages(sidebar, rewrites)).toEqual(['docs/index.md', 'docs/guide/first-run.md', 'README.md', 'docs/cli.md']);
  });
});

describe('unlistedPages', () => {
  const published = sidebarPages(sidebar, rewrites);

  it('accepts the pages the sidebar links to', () => {
    expect(unlistedPages(['README.md', 'docs/cli.md'], published)).toEqual([]);
  });

  it('reports a page the sidebar does not link to', () => {
    expect(unlistedPages(['README.md', 'docs/notes.md', 'runs/x/report.md'], published)).toEqual(['docs/notes.md', 'runs/x/report.md']);
  });
});
