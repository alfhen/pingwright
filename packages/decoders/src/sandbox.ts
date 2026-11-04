import { isValueSegment } from './fields.ts';

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

/** Replaces each path segment that looks like a value with `mask`. A sandbox prefix is kept as it is. */
export function maskValuePath(path: string, mask: string): string {
  const maskSegments = (part: string) => part.split('/').map((segment) => (isValueSegment(segment) ? mask : segment)).join('/');
  const prefix = SANDBOX_PREFIX.exec(path);
  if (!prefix) return maskSegments(path);
  const end = prefix.index + prefix[0].length;
  return maskSegments(path.slice(0, prefix.index)) + prefix[0] + maskSegments(path.slice(end));
}
