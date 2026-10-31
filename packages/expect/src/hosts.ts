import { trackerList } from '@pingwright/decoders';
import { getPublicSuffix } from 'tldts';

const HOST_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export function isHostPattern(value: unknown): value is string {
  return typeof value === 'string' && HOST_PATTERN.test(value);
}

/** A pattern is an exact host or `*.domain`, which matches any subdomain of `domain` but not `domain` itself. */
export function hostMatches(host: string, patterns: readonly string[]): boolean {
  const h = host.toLowerCase();
  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    return p.startsWith('*.') ? h.endsWith(p.slice(1)) : h === p;
  });
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Shared hosting suffixes that the Public Suffix List lacks. */
const EXTRA_SHARED_SUFFIXES = new Set(['wordpress.com']);

/** A suffix under which unrelated owners register names, by the Public Suffix List (private section included) or the local list. */
function isPublicSuffix(domain: string): boolean {
  if (EXTRA_SHARED_SUFFIXES.has(domain)) return true;
  return getPublicSuffix(domain, { allowPrivateDomains: true }) === domain;
}

const VENDOR_DOMAINS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'google.com',
  'facebook.com',
  'facebook.net',
  'pinterest.com',
];

function bareDomain(pattern: string): string {
  return pattern.toLowerCase().replace(/^\*\./, '');
}

function sameOrBelow(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isLoopbackPattern(pattern: string): boolean {
  return LOOPBACK.has(pattern.toLowerCase());
}

export function isServerHostPattern(value: unknown): value is string {
  return isHostPattern(value) || (typeof value === 'string' && isLoopbackPattern(value));
}

/**
 * A `serverHosts` entry must name the server container's own host. A wildcard on a public suffix, and any host a
 * vendor or the tracker list owns, would pass vendor hits through while the run reports `server` mode.
 */
export function isSpecificServerHost(pattern: string): boolean {
  if (isLoopbackPattern(pattern)) return true;
  const domain = bareDomain(pattern);
  const wildcard = pattern.startsWith('*.');
  if (wildcard && isPublicSuffix(domain)) return false;
  const owned = [...VENDOR_DOMAINS, ...trackerList.map((entry) => bareDomain(entry.host))];
  return !owned.some((vendor) => sameOrBelow(domain, vendor) || (wildcard && sameOrBelow(vendor, domain)));
}
