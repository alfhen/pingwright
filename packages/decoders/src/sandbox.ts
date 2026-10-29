const SANDBOX_PATH = /\/(?:web-pixels|wpm)@[^/]+\/(?:[^/]+\/)*sandbox\//;

/** True when a page URL points at a sandbox frame instead of the real page. */
export function isSandboxPageUrl(page: string | null | undefined): boolean {
  if (!page) return false;
  try {
    return SANDBOX_PATH.test(new URL(page).pathname);
  } catch {
    return SANDBOX_PATH.test(page);
  }
}
