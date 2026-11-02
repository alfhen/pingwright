import { defineMdastPlugin } from 'satteri';

/**
 * A <picture> picks its source from the OS colour scheme, not the site's theme toggle, so each one becomes
 * a light and a dark <img> that the stylesheet shows by theme. `brand/` paths point at the files that the
 * brand-assets plugin serves from the site root.
 */
export function themePictures(html: string): string {
  return html
    .replace(/<picture>([\s\S]*?)<\/picture>/g, (whole, inner: string) => {
      const dark = /<source[^>]*media="\(prefers-color-scheme: dark\)"[^>]*srcset="([^"]+)"/.exec(inner)?.[1];
      const img = /<img\b[^>]*>/.exec(inner)?.[0];
      if (!dark || !img) return whole;
      return `${img.replace('<img', '<img class="theme-light"')}${img
        .replace('<img', '<img class="theme-dark"')
        .replace(/src="[^"]+"/, `src="${dark}"`)}`;
    })
    .replace(/\b(src|srcset)="(?:\.\/)?brand\//g, '$1="/');
}

export const themedPictures = defineMdastPlugin({
  name: 'tagreeve-themed-pictures',
  html: (node) => (node.value.includes('<picture>') ? { ...node, value: themePictures(node.value) } : undefined),
});
