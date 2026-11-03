/**
 * With `build.format: 'file'` each page is built as `docs/cli.html`, and Starlight and Pagefind link to that
 * file. GitHub Pages serves the same file at `/docs/cli`, which is the page's one public URL.
 */

/** `/docs/cli.html#install` becomes `/docs/cli#install`, and `/index.html` becomes `/`. Other URLs are unchanged. */
export function cleanUrl(href: string): string {
  return href.replace(/^([^?#]*?)(\/index)?\.html(?=[?#]|$)/, (_whole, path: string, index?: string) => (index ? `${path}/` : path));
}

/** Whether `href` points into this site: a root-relative path, or an absolute URL on `site`. */
export function isSiteUrl(href: string, site?: URL): boolean {
  if (href.startsWith('/')) return !href.startsWith('//');
  return site !== undefined && href.startsWith(site.origin + '/');
}

interface SidebarEntry {
  type: 'link' | 'group';
  href?: string;
  entries?: SidebarEntry[];
}

interface PageLink {
  href: string;
}

interface HeadEntry {
  tag: string;
  attrs?: Record<string, string | boolean | undefined>;
}

/** The parts of Starlight's route data that hold page URLs. */
export interface RouteUrls {
  sidebar: SidebarEntry[];
  pagination: { prev?: PageLink | undefined; next?: PageLink | undefined };
  head: HeadEntry[];
}

/** Rewrites the sidebar, the prev and next links, the canonical link and `og:url` of a page to clean URLs. */
export function cleanRouteUrls(route: RouteUrls, site?: URL): void {
  const clean = (href: string) => (isSiteUrl(href, site) ? cleanUrl(href) : href);
  const walk = (entries: SidebarEntry[]) => {
    for (const entry of entries) {
      if (entry.href !== undefined) entry.href = clean(entry.href);
      if (entry.entries) walk(entry.entries);
    }
  };
  walk(route.sidebar);
  for (const link of [route.pagination.prev, route.pagination.next]) {
    if (link) link.href = clean(link.href);
  }
  for (const { tag, attrs } of route.head) {
    if (!attrs) continue;
    if (tag === 'link' && attrs.rel === 'canonical' && typeof attrs.href === 'string') attrs.href = clean(attrs.href);
    if (tag === 'meta' && attrs.property === 'og:url' && typeof attrs.content === 'string') attrs.content = clean(attrs.content);
  }
}
