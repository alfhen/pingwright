import type { Request } from '@tagreeve/core';

export type PlatformHostPurpose = 'telemetry' | 'cdn' | 'checkout' | 'payments';

export interface PlatformHostEntry {
  platform: string;
  /** An exact host, or `*.domain` for any subdomain of `domain`. */
  host: string;
  /** Path prefixes, matched on segment boundaries. No paths means every path on the host. */
  paths?: string[];
  purpose: PlatformHostPurpose;
  /** An https link to a page of the platform's own docs that names the host. */
  source: string;
}

/** Hosts whose pages count as a platform's own docs. An entry's `source` must be on one of them. */
export const platformHostDocsDomains: Readonly<Record<string, readonly string[]>> = {
  shopify: ['shopify.dev', 'help.shopify.com'],
};

/** Only hosts that a Shopify docs page names belong here. Add a host together with the page that names it. */
export const platformHosts: readonly PlatformHostEntry[] = [
  {
    platform: 'shopify',
    host: 'cdn.shopify.com',
    purpose: 'cdn',
    source: 'https://shopify.dev/docs/storefronts/headless/hydrogen/content-security-policy',
  },
  {
    platform: 'shopify',
    host: 'monorail-edge.shopifysvc.com',
    purpose: 'telemetry',
    source: 'https://shopify.dev/docs/storefronts/headless/hydrogen/analytics/validation',
  },
];

function hostMatches(pattern: string, hostname: string): boolean {
  return pattern.startsWith('*.') ? hostname.endsWith(pattern.slice(1)) : hostname === pattern;
}

function pathMatches(prefix: string, pathname: string): boolean {
  if (prefix.endsWith('/')) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function platformHostFor(req: Pick<Request, 'url'>, list: readonly PlatformHostEntry[] = platformHosts): PlatformHostEntry | undefined {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  return list.find((e) => hostMatches(e.host, url.hostname) && (!e.paths || e.paths.some((p) => pathMatches(p, url.pathname))));
}
