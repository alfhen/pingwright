import { describe, expect, it } from 'vitest';
import { builtPageSources, sidebarPages, unlistedPages } from '../site/src/lib/page-guard.ts';

const sidebar = [
  { label: 'guides', items: [{ label: 'First run', link: '/docs/guide/first-run' }] },
  { label: 'reference', items: [{ label: 'README', link: '/readme' }, { label: 'CLI', link: '/docs/cli' }] },
  { label: 'Elsewhere', link: 'https://example.com/' },
];

describe('sidebarPages', () => {
  it('maps sidebar links back to source pages', () => {
    expect(sidebarPages(sidebar)).toEqual(['docs/guide/first-run.md', 'README.md', 'docs/cli.md']);
  });
});

describe('builtPageSources', () => {
  it('maps the paths Astro built back to source pages, without the home and 404 pages', () => {
    expect(builtPageSources(['', '404', 'readme', 'docs/cli', '/docs/guide/first-run/'])).toEqual(['README.md', 'docs/cli.md', 'docs/guide/first-run.md']);
  });
});

describe('unlistedPages', () => {
  const published = sidebarPages(sidebar);

  it('accepts the pages the sidebar links to', () => {
    expect(unlistedPages(['README.md', 'docs/cli.md'], published)).toEqual([]);
  });

  it('reports a page the sidebar does not link to', () => {
    expect(unlistedPages(['README.md', 'docs/notes.md', 'docs/zz-unlisted.md'], published)).toEqual(['docs/notes.md', 'docs/zz-unlisted.md']);
  });
});
