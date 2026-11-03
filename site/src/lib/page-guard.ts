import { pageSource } from './docs-pages.ts';

export interface SidebarItem {
  link?: string;
  items?: readonly SidebarItem[];
}

function links(items: readonly SidebarItem[]): string[] {
  return items.flatMap((item) => [...(item.link ? [item.link] : []), ...links(item.items ?? [])]);
}

/** The source files of the pages the sidebar links to. */
export function sidebarPages(sidebar: readonly SidebarItem[]): string[] {
  return links(sidebar)
    .filter((link) => link.startsWith('/') && link !== '/')
    .map((link) => pageSource(link.slice(1).replace(/\/$/, '')));
}

/** The source files of built pages, from the paths Astro reports. The home page and the 404 page have no source. */
export function builtPageSources(pathnames: readonly string[]): string[] {
  return pathnames
    .map((pathname) => pathname.replace(/^\/|\/$/g, '').replace(/\.html$/, ''))
    .filter((id) => id !== '' && id !== '404')
    .map(pageSource);
}

export function unlistedPages(pages: readonly string[], published: readonly string[]): string[] {
  const allowed = new Set(published);
  return pages.filter((page) => !allowed.has(page));
}
