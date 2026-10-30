export const publishedPages = [
  'README.md',
  'docs/cli.md',
  'docs/shopify-checkout.md',
  'docs/design.md',
  'docs/release.md',
];

export function unlistedPages(pages: readonly string[]): string[] {
  const allowed = new Set([...publishedPages, 'index.md']);
  return pages.filter((page) => !allowed.has(page));
}
