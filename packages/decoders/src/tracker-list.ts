import type { Request } from '@pingwright/core';
import { vendorKeys } from './decoder.ts';

export interface TrackerEntry {
  vendor: string;
  /** An exact host, or `*.domain` for any subdomain of `domain`. */
  host: string;
  /** Path prefixes, matched on segment boundaries. No paths means every path on the host. */
  paths?: string[];
  /** An https link to the vendor's own docs. */
  source: string;
}

/** Hosts whose pages count as a vendor's own docs. A built-in entry's `source` must be on one of them. */
export const trackerDocsDomains: Readonly<Record<string, readonly string[]>> = {
  linkedin: ['linkedin.com'],
  'microsoft-uet': ['microsoft.com'],
  reddit: ['reddithelp.com'],
};

export const trackerList: readonly TrackerEntry[] = [
  {
    vendor: 'linkedin',
    host: 'px.ads.linkedin.com',
    paths: ['/wa'],
    source: 'https://www.linkedin.com/help/lms/answer/a425696',
  },
  {
    vendor: 'linkedin',
    host: 'px.ads.linkedin.com',
    source: 'https://www.linkedin.com/help/lms/answer/a425696',
  },
  {
    vendor: 'microsoft-uet',
    host: 'bat.bing.com',
    paths: ['/action/0'],
    source: 'https://learn.microsoft.com/en-us/advertising/msa-help/hlp_ba_proc_uetv2addtag',
  },
  {
    vendor: 'reddit',
    host: 'alb.reddit.com',
    source: 'https://business.reddithelp.com/articles/Knowledge/reddit-pixel',
  },
];

export const trackerVendorKeys: readonly string[] = [...new Set(trackerList.map((e) => e.vendor))];

function hostMatches(pattern: string, hostname: string): boolean {
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
}

function pathMatches(prefix: string, pathname: string): boolean {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function trackerFor(
  req: Pick<Request, 'url'>,
  list: readonly TrackerEntry[] = trackerList,
): TrackerEntry | undefined {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  return list.find(
    (e) => hostMatches(e.host, url.hostname) && (!e.paths || e.paths.some((p) => pathMatches(p, url.pathname))),
  );
}

const HOST = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function parseEntry(raw: unknown, at: string): TrackerEntry {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${at}: must be an object`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!['vendor', 'host', 'paths', 'source'].includes(k)) throw new Error(`${at}: unknown field "${k}"`);
  }
  const { vendor, host, paths, source } = o;
  if (typeof vendor !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(vendor)) {
    throw new Error(`${at}: "vendor" must be a lowercase key such as "tiktok"`);
  }
  if (vendorKeys.includes(vendor)) {
    throw new Error(`${at}: "vendor" "${vendor}" is a built-in decoder key; choose another key`);
  }
  if (typeof host !== 'string' || !HOST.test(host)) {
    throw new Error(`${at}: "host" must be a lowercase host such as "t.example.com" or "*.example.com"`);
  }
  if (
    paths !== undefined &&
    (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === 'string' && p.startsWith('/')))
  ) {
    throw new Error(`${at}: "paths" must be a non-empty list of strings that start with "/"`);
  }
  if (typeof source !== 'string' || !isHttps(source)) {
    throw new Error(`${at}: "source" must be an https link to the vendor's docs`);
  }
  return paths === undefined ? { vendor, host, source } : { vendor, host, paths: paths as string[], source };
}

function isHttps(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

export function parseTrackerList(json: unknown): TrackerEntry[] {
  if (!Array.isArray(json)) throw new Error('tracker list: must be a JSON array of entries');
  return json.map((raw, i) => parseEntry(raw, `tracker list entry ${i}`));
}
