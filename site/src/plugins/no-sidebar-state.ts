import type { ViteUserConfig } from 'astro';

type Plugin = Extract<NonNullable<ViteUserConfig['plugins']>[number], { name: string }>;

/**
 * Starlight's page always loads a script that saves the sidebar state in sessionStorage. The site may
 * store only the theme and the intro flag, so that script is replaced with an empty module.
 */
export function noSidebarState(): Plugin {
  return {
    name: 'tagreeve-no-sidebar-state',
    enforce: 'pre',
    load(id) {
      return /@astrojs[\\/]starlight[\\/]dist[\\/]components-internals[\\/]SidebarPersistState\.js$/.test(id.split('?')[0]!) ? 'export {};' : undefined;
    },
  };
}
