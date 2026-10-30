import { expect, test } from 'vitest';
import { gtmFailureMessage, matchGtmRequest, parseGtmOverride, previewFetchUrl } from './gtm-override.ts';

const valid = { container: 'GTM-PWTEST1', gtmAuth: 'pwfake-auth-0001', gtmPreview: 'env-99' };
const replaceUrl = 'https://sgtm.example.com/opaque-loader.js';
const withReplace = { ...valid, loader: { replace: replaceUrl } };

const request = (url: string) => ({ type: 'request', url, method: 'GET', headers: {}, postData: null }) as never;

test('loader.replace matches a URL that the Stape loader matcher cannot unwrap', () => {
  const override = parseGtmOverride(withReplace);
  expect(matchGtmRequest(replaceUrl, request(replaceUrl), override)?.applied).toMatchObject({ way: 'replace', url: replaceUrl });
  const other = 'https://sgtm.example.com/other.js';
  expect(matchGtmRequest(other, request(other), override)).toBeUndefined();
});

test('a loader.replace match keeps l and gtm_debug from the matched URL', () => {
  const url = 'https://sgtm.example.com/opaque-loader.js?l=dl&gtm_debug=x';
  const override = parseGtmOverride({ ...valid, loader: { replace: url } });
  const match = matchGtmRequest(url, request(url), override)!;
  expect(match.applied.way).toBe('replace');
  const fetched = new URL(previewFetchUrl(override, undefined, match.pageParams));
  expect(fetched.searchParams.get('l')).toBe('dl');
  expect(fetched.searchParams.get('gtm_debug')).toBe('x');
});

test('the preview fetch copies l and gtm_debug from the matched request', () => {
  const override = parseGtmOverride(valid);
  const directUrl = 'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=dl&gtm_debug=x';
  const direct = matchGtmRequest(directUrl, request(directUrl), override)!;
  const url = new URL(previewFetchUrl(override, undefined, direct.pageParams));
  expect(url.searchParams.get('l')).toBe('dl');
  expect(url.searchParams.get('gtm_debug')).toBe('x');
  expect(url.searchParams.get('gtm_auth')).toBe(valid.gtmAuth);

  const pk = encodeURIComponent(Buffer.from('/gtm.js?id=GTM-PWTEST1&l=dl').toString('base64'));
  const stapeUrl = `https://sgtm.example.com/abc?pk=${pk}`;
  const loader = matchGtmRequest(stapeUrl, request(stapeUrl), override)!;
  expect(loader.applied.way).toBe('loader');
  expect(new URL(previewFetchUrl(override, undefined, loader.pageParams)).searchParams.get('l')).toBe('dl');
  expect(new URL(previewFetchUrl(override)).searchParams.has('l')).toBe(false);
});

test('the failure message covers all three ways and fails an unused loader.replace', () => {
  const override = parseGtmOverride(withReplace);
  const none = gtmFailureMessage(override, [])!;
  expect(none).toContain('Stape-style loader');
  expect(none).toContain(replaceUrl);
  const direct = { way: 'direct' as const, url: 'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1', status: 200 };
  expect(gtmFailureMessage(override, [direct])).toContain('loader.replace was set but the page never requested');
  expect(gtmFailureMessage(override, [direct, { way: 'replace', url: replaceUrl, status: 200 }])).toBeUndefined();
  expect(gtmFailureMessage(parseGtmOverride(valid), [direct])).toBeUndefined();
  expect(gtmFailureMessage(parseGtmOverride(valid), [])).not.toContain(', or ');
});
