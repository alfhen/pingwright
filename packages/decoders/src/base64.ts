const ALPHABET = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Standard or url-safe base64, padded or not. Returns undefined for anything that is not strict base64 text. */
export function decodeBase64Text(value: string): string | undefined {
  // A raw "+" in a query string arrives as a space.
  const v = value.replace(/ /g, '+');
  if (v.length < 4 || !ALPHABET.test(v)) return undefined;
  const bare = v.replace(/=+$/, '');
  if (bare.length % 4 === 1) return undefined;
  const text = Buffer.from(bare.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return text.includes('�') ? undefined : text;
}
