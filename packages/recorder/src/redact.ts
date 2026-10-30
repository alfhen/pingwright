const REDACTED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, REDACTED_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v]),
  );
}
