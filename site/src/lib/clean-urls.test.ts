import { describe, expect, it } from 'vitest';
import { cleanRouteUrls, cleanUrl, isSiteUrl, type RouteUrls } from './clean-urls.ts';

const site = new URL('https://tagreeve.dev');

describe('cleanUrl', () => {
  it('drops .html and keeps the query and the fragment', () => {
    expect(cleanUrl('/docs/cli.html')).toBe('/docs/cli');
    expect(cleanUrl('/docs/cli.html#install')).toBe('/docs/cli#install');
    expect(cleanUrl('/docs/guide/first-run.html?q=1#x')).toBe('/docs/guide/first-run?q=1#x');
    expect(cleanUrl('https://tagreeve.dev/readme.html')).toBe('https://tagreeve.dev/readme');
  });

  it('turns an index file into its folder', () => {
    expect(cleanUrl('/index.html')).toBe('/');
    expect(cleanUrl('https://tagreeve.dev/index.html')).toBe('https://tagreeve.dev/');
  });

  it('leaves clean URLs and .html in a fragment or query alone', () => {
    for (const href of ['/docs/cli', '/', '#install', '/docs/cli#a.html', '/docs/cli?x=a.html', '/docs/htmlish']) {
      expect(cleanUrl(href)).toBe(href);
    }
  });
});

describe('isSiteUrl', () => {
  it('accepts root-relative paths and URLs on the site, and nothing else', () => {
    expect(isSiteUrl('/docs/cli.html', site)).toBe(true);
    expect(isSiteUrl('https://tagreeve.dev/docs/cli.html', site)).toBe(true);
    expect(isSiteUrl('//example.com/a.html', site)).toBe(false);
    expect(isSiteUrl('https://example.com/a.html', site)).toBe(false);
    expect(isSiteUrl('https://tagreeve.dev.example.com/a.html', site)).toBe(false);
  });
});

describe('cleanRouteUrls', () => {
  it('cleans the sidebar, the prev and next links, the canonical link and og:url', () => {
    const route: RouteUrls = {
      sidebar: [
        {
          type: 'group',
          entries: [
            { type: 'link', href: '/docs/guide/first-run.html' },
            { type: 'link', href: 'https://github.com/alfhen/tagreeve/blob/main/page.html' },
          ],
        },
        { type: 'link', href: '/readme.html' },
      ],
      pagination: { prev: { href: '/docs/guide/first-run.html' }, next: { href: '/docs/cli.html' } },
      head: [
        { tag: 'link', attrs: { rel: 'canonical', href: 'https://tagreeve.dev/docs/cli.html' } },
        { tag: 'meta', attrs: { property: 'og:url', content: 'https://tagreeve.dev/docs/cli.html' } },
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.html' } },
      ],
    };
    cleanRouteUrls(route, site);
    expect(route.sidebar[0]!.entries!.map((entry) => entry.href)).toEqual(['/docs/guide/first-run', 'https://github.com/alfhen/tagreeve/blob/main/page.html']);
    expect(route.sidebar[1]!.href).toBe('/readme');
    expect(route.pagination.prev!.href).toBe('/docs/guide/first-run');
    expect(route.pagination.next!.href).toBe('/docs/cli');
    expect(route.head.map((entry) => entry.attrs)).toEqual([
      { rel: 'canonical', href: 'https://tagreeve.dev/docs/cli' },
      { property: 'og:url', content: 'https://tagreeve.dev/docs/cli' },
      { rel: 'icon', href: '/favicon.html' },
    ]);
  });

  it('works on a page without prev or next', () => {
    const route: RouteUrls = { sidebar: [], pagination: {}, head: [] };
    expect(() => cleanRouteUrls(route, site)).not.toThrow();
  });
});
