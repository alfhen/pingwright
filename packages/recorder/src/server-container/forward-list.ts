export type ForwardClass = 'serverjs' | 'config' | 'destination';

interface ForwardRow {
  readonly class: ForwardClass;
  readonly host: string;
  readonly path: string;
  readonly match: 'prefix' | 'exact';
}

export const forwardList: readonly ForwardRow[] = [
  { class: 'serverjs', host: 'www.googletagmanager.com', path: '/static/serverjs/', match: 'prefix' },
  { class: 'config', host: 'www.googletagmanager.com', path: '/server.js', match: 'exact' },
  { class: 'destination', host: 'www.googletagmanager.com', path: '/s/gtag/destination', match: 'exact' },
];

const FORWARD_METHODS = new Set(['GET', 'HEAD']);

// A prefix row must not be escaped with dot segments, encoded slashes or backslashes.
function isUnsafePath(pathname: string): boolean {
  return /(^|\/)(\.|%2e){1,2}(\/|$)/i.test(pathname) || pathname.includes('\\') || /%2f|%5c/i.test(pathname);
}

/** Returns the class of a request the container may send on to Google, or undefined. */
export function classifyForward(method: string, url: URL): ForwardClass | undefined {
  if (!FORWARD_METHODS.has(method)) return undefined;
  if (url.protocol !== 'https:') return undefined;
  if (url.port !== '' && url.port !== '443') return undefined;
  if (isUnsafePath(url.pathname)) return undefined;
  for (const row of forwardList) {
    if (url.hostname !== row.host) continue;
    const hit = row.match === 'exact' ? url.pathname === row.path : url.pathname.startsWith(row.path);
    if (hit) return row.class;
  }
  return undefined;
}
