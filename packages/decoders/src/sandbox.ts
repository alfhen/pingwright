const SANDBOX_PATH = /\/(?:web-pixels|wpm)@[^/]+\/(?:[^/]+\/)*?sandbox\//;
const SANDBOX_PREFIX = new RegExp(`${SANDBOX_PATH.source}[^/]*`);

/** True when a page URL points at a sandbox frame instead of the real page. */
export function isSandboxPageUrl(page: string | null | undefined): boolean {
  if (!page) return false;
  try {
    return SANDBOX_PATH.test(new URL(page).pathname);
  } catch {
    return SANDBOX_PATH.test(page);
  }
}

/** Drops the `/web-pixels@<hash>/.../sandbox/<mode>` prefix from a URL path, so the same page compares equal across Shopify deploys. */
export function stripSandboxPrefix(path: string): string {
  return path.replace(SANDBOX_PREFIX, '') || '/';
}
