import { trackerList } from '@pingwright/decoders';

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

/** Shared hosting suffixes whose subdomains belong to different owners. A short list, not the full Public Suffix List. */
const SHARED_SUFFIXES = new Set(['myshopify.com', 'github.io', 'herokuapp.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'blogspot.com', 'wordpress.com', 'wixsite.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com']);

/** `*.<tld>` and `*.<2 to 3 letters>.<two-letter tld>` (`*.co.uk`, `*.com.au`, `*.co.kr`) are public suffixes. */
function isPublicSuffix(domain: string): boolean {
  const labels = domain.split('.');
  if (labels.length === 1) return true;
  if (SHARED_SUFFIXES.has(domain)) return true;
  return labels.length === 2 && labels[1]!.length === 2 && labels[0]!.length <= 3;
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
