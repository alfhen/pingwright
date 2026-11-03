const REDACTED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'access-token', 'x-api-key']);
const REDACTED = '[redacted]';

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, REDACTED_HEADERS.has(k.toLowerCase()) ? REDACTED : v]),
  );
}

/** Query and body names whose values are vendor secrets. The Meta Conversions API sends its access token in the URL. */
export const SECRET_VALUE_NAMES = ['access_token', 'appsecret_proof'] as const;

const NAMES = SECRET_VALUE_NAMES.join('|');
const IN_URL = new RegExp(`([?&;])(${NAMES})=[^&#]*`, 'gi');
const IN_FORM = new RegExp(`(^|&)(${NAMES})=[^&]*`, 'gi');
const IN_JSON = new RegExp(`("(?:${NAMES})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|[^,}\\]\\s]+)`, 'gi');

/** The URL with the values of the secret names replaced. */
export function redactSecretsInUrl(url: string): string {
  return url.replace(IN_URL, `$1$2=${REDACTED}`);
}

/** A JSON or form body with the values of the secret names replaced. Text that is neither is checked for both shapes. */
export function redactSecretsInBody(body: string): string {
  return body.replace(IN_JSON, `$1"${REDACTED}"`).replace(IN_FORM, `$1$2=${REDACTED}`);
}
