import type { GtmOverrideTag } from '@pingwright/core';

export const GTM_ORIGIN = 'https://www.googletagmanager.com';
export const TEST_GTM_ORIGIN_ENV = 'PINGWRIGHT_TEST_GTM_ORIGIN';

const CONTAINER = /^GTM-[A-Z0-9]+$/;
const AUTH = /^[A-Za-z0-9_-]+$/;
const PREVIEW = /^env-\d+$/;

export interface GtmOverrideInput {
  container: string;
  gtmAuth: string;
  gtmPreview: string;
  expectedTags?: GtmOverrideTag[];
  /** Loader scripts to replace with the preview build: one exact URL, and/or a regex tested against script URLs. */
  loader?: { replace?: string; match?: string };
}

export class GtmOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GtmOverrideError';
  }
}

/** Error messages never repeat a value from the input, because `gtmAuth` must not reach any output. */
export function parseGtmOverride(input: unknown): GtmOverrideInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new GtmOverrideError('the GTM override must be a JSON object');
  const o = input as Record<string, unknown>;
  const known = new Set(['container', 'gtmAuth', 'gtmPreview', 'expectedTags', 'loader']);
  if (Object.keys(o).some((k) => !known.has(k))) {
    throw new GtmOverrideError('the GTM override has unknown fields. Allowed: container, gtmAuth, gtmPreview, expectedTags, loader');
  }
  if (typeof o.container !== 'string' || !CONTAINER.test(o.container)) {
    throw new GtmOverrideError('container must be a string that matches ^GTM-[A-Z0-9]+$');
  }
  if (typeof o.gtmAuth !== 'string' || !AUTH.test(o.gtmAuth)) {
    throw new GtmOverrideError('gtmAuth must be a non-empty string of letters, digits, "-" and "_"');
  }
  if (typeof o.gtmPreview !== 'string' || !PREVIEW.test(o.gtmPreview)) {
    throw new GtmOverrideError('gtmPreview must look like env-12');
  }
  const expectedTags: GtmOverrideTag[] = [];
  if (o.expectedTags !== undefined) {
    if (!Array.isArray(o.expectedTags)) throw new GtmOverrideError('expectedTags must be a list');
    for (const [i, tag] of o.expectedTags.entries()) {
      const t = tag as Record<string, unknown> | null;
      if (typeof t !== 'object' || t === null || typeof t.id !== 'string' || t.id === '') {
        throw new GtmOverrideError(`expectedTags[${i}] needs a string id`);
      }
      if (t.name !== undefined && t.name !== null && typeof t.name !== 'string') {
        throw new GtmOverrideError(`expectedTags[${i}].name must be a string`);
      }
      expectedTags.push({ id: t.id, name: typeof t.name === 'string' ? t.name : null });
    }
  }
  const result: GtmOverrideInput = { container: o.container, gtmAuth: o.gtmAuth, gtmPreview: o.gtmPreview, expectedTags };
  if (o.loader !== undefined) result.loader = parseLoader(o.loader);
  return result;
}

function parseLoader(input: unknown): { replace?: string; match?: string } {
  const bad = (m: string) => new GtmOverrideError(m);
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw bad('loader must be an object like {"replace": "<script URL>"} or {"match": "<regex>"}');
  }
  const l = input as Record<string, unknown>;
  if (Object.keys(l).some((k) => k !== 'replace' && k !== 'match')) throw bad('loader has unknown fields. Allowed: replace, match');
  if (l.replace === undefined && l.match === undefined) throw bad('loader needs replace (a script URL) or match (a regex)');
  const result: { replace?: string; match?: string } = {};
  if (l.replace !== undefined) {
    if (typeof l.replace !== 'string') throw bad('loader.replace must be a script URL');
    let url: URL;
    try {
      url = new URL(l.replace);
    } catch {
      throw bad('loader.replace must be an absolute http or https URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('loader.replace must be an absolute http or https URL');
    result.replace = url.href;
  }
  if (l.match !== undefined) {
    if (typeof l.match !== 'string' || l.match === '') throw bad('loader.match must be a non-empty regular expression string');
    try {
      new RegExp(l.match);
    } catch {
      throw bad('loader.match is not a valid regular expression');
    }
    result.match = l.match;
  }
  return result;
}

/** Returns the origin of a loopback test GTM origin, or undefined when the variable is unset or empty. Anything else throws. */
export function parseTestGtmOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  const bad = () => new GtmOverrideError(`${TEST_GTM_ORIGIN_ENV} must be http://localhost, http://127.0.0.1 or http://[::1], with an optional port and nothing else`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw bad();
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'http:' || !loopback || /[?#@]/.test(value) || url.username || url.password || url.pathname !== '/') throw bad();
  return url.origin;
}

/** True for a request to the GTM container script of any container. */
export function isGtmJsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.origin === GTM_ORIGIN && u.pathname === '/gtm.js';
  } catch {
    return false;
  }
}

/** Only `id` counts. Other parameters such as `l=` are ignored, and `gtag/js` and `ns.html` never match. */
export function matchesGtmContainer(url: string, container: string): boolean {
  return isGtmJsUrl(url) && new URL(url).searchParams.get('id') === container;
}

/** `inner` is the request a Stape-style loader URL stands for. Any host counts, because the loader host is the site's own. */
export function matchesLoaderContainer(inner: string, container: string): boolean {
  try {
    const u = new URL(inner);
    return u.pathname === '/gtm.js' && u.searchParams.get('id') === container;
  } catch {
    return false;
  }
}

export function previewFetchUrl(override: GtmOverrideInput, origin: string = GTM_ORIGIN): string {
  const q = `id=${encodeURIComponent(override.container)}&gtm_auth=${encodeURIComponent(override.gtmAuth)}&gtm_preview=${encodeURIComponent(override.gtmPreview)}&gtm_cookies_win=x`;
  return `${origin}/gtm.js?${q}`;
}

/** The page's own gtm.js request, fetched from the test origin instead. */
export function testOriginUrl(requestUrl: string, origin: string): string {
  const u = new URL(requestUrl);
  return `${origin}${u.pathname}${u.search}`;
}

/** Only script requests match, so a host-wide pattern cannot capture the server container's data requests. */
export function matchesLoaderPattern(url: string, resourceType: string, loader: { match?: string } | undefined): boolean {
  return resourceType === 'script' && loader?.match !== undefined && new RegExp(loader.match).test(url);
}

const GOOGLE_HOST = /(^|\.)(googletagmanager|google-analytics|googleadservices|doubleclick)\.(com|net)$/;

/** A script request that could be a Stape loader: a `.js` path with a query, on a host that is not Google's. */
export function isLoaderCandidate(url: string, resourceType: string): boolean {
  if (resourceType !== 'script') return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !GOOGLE_HOST.test(u.hostname) && u.pathname.endsWith('.js') && u.search !== '';
  } catch {
    return false;
  }
}

/** The body of a GTM container script holds its container ID. */
export function bodyHasContainer(body: string, container: string): boolean {
  return body.includes(container);
}

/** Origin and path with the query values hidden, because they may hold per-site keys. */
export function withoutQueryValues(url: string): string {
  try {
    const u = new URL(url);
    const keys = [...new Set(u.searchParams.keys())];
    return `${u.origin}${u.pathname}${keys.length ? `?${keys.map((k) => `${k}=…`).join('&')}` : ''}`;
  } catch {
    return '(unparsable URL)';
  }
}

const REPLACE_OR_MATCH = '"loader": {"replace": "<script URL>"} or {"match": "<regex>"}';

/** The tail of the no-match message. `sniffed` are scripts the recorder fetched and checked; `seen` are all cross-origin script requests. */
export function loaderHint(sniffed: readonly string[], seen: readonly string[]): string {
  const checked = new Set(sniffed.map(withoutQueryValues));
  const urls = [...new Set([...sniffed, ...seen].map(withoutQueryValues))].slice(0, 10);
  if (urls.length === 0) return `. If the page uses a custom loader, add ${REPLACE_OR_MATCH} to the override file`;
  const unchecked = urls.some((u) => !checked.has(u));
  const advice = unchecked ? '; to have the default way check a host automatically, add it to options.firstPartyHosts' : '';
  return `. Cross-origin scripts that were not the container (query values hidden): ${urls.join(', ')}. If one is your loader, add ${REPLACE_OR_MATCH} to the override file${advice}`;
}
