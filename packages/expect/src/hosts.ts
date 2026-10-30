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
