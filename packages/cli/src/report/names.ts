export const VENDOR_NAMES: Readonly<Record<string, string>> = {
  ga4: 'Google Analytics 4',
  'google-ads': 'Google Ads',
  meta: 'Meta',
  pinterest: 'Pinterest',
  sgtm: 'server container',
  linkedin: 'LinkedIn',
  'microsoft-uet': 'Microsoft UET',
  reddit: 'Reddit',
};

/** A key with no entry, such as a `--tracker-list` vendor, is its own name. */
export function vendorName(key: string): string {
  return Object.hasOwn(VENDOR_NAMES, key) ? VENDOR_NAMES[key]! : key;
}

export function vendorLabel(key: string): string {
  const name = vendorName(key);
  return name === key ? key : `${name} (${key})`;
}

export const byVendorName = (a: string, b: string): number => vendorName(a).localeCompare(vendorName(b)) || a.localeCompare(b);
