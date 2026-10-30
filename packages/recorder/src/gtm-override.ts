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
  const known = new Set(['container', 'gtmAuth', 'gtmPreview', 'expectedTags']);
  if (Object.keys(o).some((k) => !known.has(k))) {
    throw new GtmOverrideError('the GTM override has unknown fields. Allowed: container, gtmAuth, gtmPreview, expectedTags');
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
  return { container: o.container, gtmAuth: o.gtmAuth, gtmPreview: o.gtmPreview, expectedTags };
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

export function previewFetchUrl(override: GtmOverrideInput, origin: string = GTM_ORIGIN): string {
  const q = `id=${encodeURIComponent(override.container)}&gtm_auth=${encodeURIComponent(override.gtmAuth)}&gtm_preview=${encodeURIComponent(override.gtmPreview)}&gtm_cookies_win=x`;
  return `${origin}/gtm.js?${q}`;
}

/** The page's own gtm.js request, fetched from the test origin instead. */
export function testOriginUrl(requestUrl: string, origin: string): string {
  const u = new URL(requestUrl);
  return `${origin}${u.pathname}${u.search}`;
}
