import type { AstroIntegration } from 'astro';
import { builtPageSources, sidebarPages, unlistedPages, type SidebarItem } from '../lib/page-guard.ts';

/** Fails the build when a markdown page is published that the sidebar does not list. */
export function pageGuard(sidebar: readonly SidebarItem[]): AstroIntegration {
  return {
    name: 'tagreeve-page-guard',
    hooks: {
      'astro:build:done': ({ pages }) => {
        const extra = unlistedPages(builtPageSources(pages.map((page) => page.pathname)), sidebarPages(sidebar));
        if (extra.length) throw new Error(`Pages not in the published list: ${extra.join(', ')}`);
      },
    },
  };
}
