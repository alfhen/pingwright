import type { GtmOverrideApplied, GtmOverrideTag, Request } from '@pingwright/core';
import { unwrapStapeLoader } from '@pingwright/decoders';

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

/** `pageParams` are the matched request's parameters. `l` (the data layer name) and `gtm_debug` are copied, because the build reads the data layer that `l` names. */
export function previewFetchUrl(override: GtmOverrideInput, origin: string = GTM_ORIGIN, pageParams?: URLSearchParams): string {
  const q = new URLSearchParams({ id: override.container, gtm_auth: override.gtmAuth, gtm_preview: override.gtmPreview, gtm_cookies_win: 'x' });
  for (const name of ['l', 'gtm_debug']) {
    const value = pageParams?.get(name);
    if (value) q.set(name, value);
  }
  return `${origin}/gtm.js?${q.toString()}`;
}

export interface GtmMatch {
  applied: Omit<GtmOverrideApplied, 'status'>;
  /** Parameters of the request that carries the container id. */
  pageParams: URLSearchParams;
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/** `liveUrl` is the request as sent. `record.url` may be redacted, so it is only reported. */
export function matchGtmRequest(liveUrl: string, record: Request, override: GtmOverrideInput): GtmMatch | undefined {
  if (matchesGtmContainer(liveUrl, override.container)) {
    return { applied: { way: 'direct', url: record.url }, pageParams: new URL(liveUrl).searchParams };
  }
  const replaced =
    (override.loader?.replace !== undefined && sameUrl(liveUrl, override.loader.replace)) ||
    matchesLoaderPattern(liveUrl, record.resourceType, override.loader);
  if (replaced) {
    return {
      applied: { way: 'replace', url: record.url, loses: 'everything the loader does beyond fetching the container' },
      pageParams: new URL(liveUrl).searchParams,
    };
  }
  const inner = unwrapStapeLoader({ ...record, url: liveUrl });
  if (inner && matchesLoaderContainer(inner.url, override.container)) {
    return {
      applied: { way: 'loader', loader: 'stape', url: record.url, loses: 'nothing known; the loader script runs unchanged' },
      pageParams: new URL(inner.url).searchParams,
    };
  }
  return undefined;
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

/**
 * A gtm.js body names the exact container ID and registers `google_tag_manager`. The marker keeps out
 * bundles that only embed the GTM snippet; the ID boundaries keep out GTM-AB123 when the container is GTM-AB12.
 */
export function bodyHasContainer(body: string, container: string): boolean {
  if (!body.includes('google_tag_manager')) return false;
  const escaped = container.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(body);
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

/** Why the override did not take effect, or undefined when it did. */
export function gtmFailureMessage(override: GtmOverrideInput, applied: GtmOverrideApplied[], fetchError?: string, hint = ''): string | undefined {
  const { container } = override;
  const replace = override.loader?.replace;
  if (applied.length === 0) {
    return `no container request matched: the page never requested https://www.googletagmanager.com/gtm.js?id=${container}, a Stape-style loader for it${replace ? `, or ${replace}` : ''}, and no loader script held the container${hint}`;
  }
  const bad = applied.find((a) => a.status !== 200);
  if (bad) {
    if (bad.status === 0) return `the preview build of ${container} could not be fetched${fetchError ? `: ${fetchError}` : ''}`;
    const note = bad.status === 404 ? ' (the environment may have no version)' : '';
    return `the preview build of ${container} returned status ${bad.status}${note}`;
  }
  if (replace && !applied.some((a) => a.way === 'replace')) return `loader.replace was set but the page never requested ${replace}`;
  return undefined;
}
