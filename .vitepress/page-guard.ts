export interface SidebarItem {
  link?: string;
  items?: readonly SidebarItem[];
}

function links(items: readonly SidebarItem[]): string[] {
  return items.flatMap((item) => [...(item.link ? [item.link] : []), ...links(item.items ?? [])]);
}

/** The source pages the sidebar links to, undoing `rewrites` (source path to served path). */
export function sidebarPages(sidebar: readonly SidebarItem[], rewrites: Record<string, string>): string[] {
  const sourceOf = new Map(Object.entries(rewrites).map(([source, served]) => [served, source]));
  return links(sidebar)
    .filter((link) => link.startsWith('/'))
    .map((link) => {
      const served = link === '/' ? 'index.md' : `${link.slice(1)}.md`;
      return sourceOf.get(served) ?? served;
    });
}

export function unlistedPages(pages: readonly string[], published: readonly string[]): string[] {
  const allowed = new Set(published);
  return pages.filter((page) => !allowed.has(page));
}
