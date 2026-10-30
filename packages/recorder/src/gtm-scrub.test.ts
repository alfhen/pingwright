import { expect, test } from 'vitest';
import { containsSecret, REDACTED, Scrubber } from './gtm-scrub.ts';

const secret = 'pwfake-auth-0001';
const b64 = (s: string) => Buffer.from(s).toString('base64');
const scrub = new Scrubber(secret);

test('finds the secret in plain, URL-encoded and base64 layers, and in nested query strings', () => {
  expect(containsSecret(`a=${secret}`, secret)).toBe(true);
  expect(containsSecret(encodeURIComponent(`x y&gtm_auth=${secret}`), secret)).toBe(true);
  expect(containsSecret(b64(`gtm_auth=${secret}`), secret)).toBe(true);
  expect(containsSecret(b64(b64(`gtm_auth=${secret}`)), secret)).toBe(true);
  const dtdc = b64(JSON.stringify({ page_location: `https://x.example.com/?gtm_auth=${secret}` }));
  expect(containsSecret(encodeURIComponent(b64(`/data?v=2&dtdc=${dtdc}`)), secret)).toBe(true);
  expect(containsSecret('/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=page_view', secret)).toBe(false);
  expect(containsSecret(b64('nothing to see here at all'), secret)).toBe(false);
});

test('a URL with the secret inside base64 twice has only that value redacted', () => {
  const dtdc = b64(JSON.stringify({ page_location: `https://shop.example.com/?gtm_auth=${secret}` }));
  const inner = `/data?v=2&tid=G-PWTEST0001&dtdc=${encodeURIComponent(dtdc)}`;
  const url = `http://127.0.0.1:4000/pwstape?pk=${encodeURIComponent(b64(inner))}&x=1`;
  expect(scrub.url(url)).toBe(`http://127.0.0.1:4000/pwstape?pk=${REDACTED}&x=1`);
});

test('a URL without the secret is unchanged, and a secret outside the query redacts the whole URL', () => {
  const clean = `http://127.0.0.1:4000/pwstape?pk=${encodeURIComponent(b64('/g/collect?v=2&tid=G-PWTEST0001'))}`;
  expect(scrub.url(clean)).toBe(clean);
  expect(scrub.url(`https://example.com/${secret}/x?a=1`)).toBe(REDACTED);
});

test('form bodies lose only the values that hold the secret, batched lines included', () => {
  expect(scrub.body(`gtm_auth=${secret}&a=1`)).toBe(`gtm_auth=${REDACTED}&a=1`);
  expect(scrub.body(`en=a&dl=${encodeURIComponent(b64(secret))}\nen=b&x=2`)).toBe(`en=a&dl=${REDACTED}\nen=b&x=2`);
  expect(scrub.body(JSON.stringify({ a: b64(secret) }))).toBe(REDACTED);
  expect(scrub.body('en=a&x=2')).toBe('en=a&x=2');
});

test('strings in objects and arrays are redacted whole', () => {
  const out = scrub.deep({ page: `https://x.example.com/?gtm_auth=${secret}`, params: { dl: b64(`u=${secret}`), ok: 'fine' }, args: [1, [secret]] });
  expect(out).toEqual({ page: REDACTED, params: { dl: REDACTED, ok: 'fine' }, args: [1, [REDACTED]] });
});

test('text keeps the line but redacts the secret, and a decoded form redacts the line', () => {
  expect(scrub.text(`bad ${secret} here\nfine\nenc ${b64(secret)}`)).toBe(`bad ${REDACTED} here\nfine\n${REDACTED}`);
});
