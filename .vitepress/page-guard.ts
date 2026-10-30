export const publishedPages = [
  'README.md',
  'docs/index.md',
  'docs/guide/what-it-checks.md',
  'docs/guide/first-run.md',
  'docs/guide/reading-results.md',
  'docs/cli.md',
  'docs/shopify-checkout.md',
  'docs/design.md',
];

export function unlistedPages(pages: readonly string[]): string[] {
  const allowed = new Set(publishedPages);
  return pages.filter((page) => !allowed.has(page));
}
