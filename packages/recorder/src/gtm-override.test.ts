import { expect, test } from 'vitest';
import { bodyHasContainer, isLoaderHost, isGtmJsUrl, isLoaderCandidate, isCrossOriginLoaderCandidate, isSniffableLoader, matchesGtmContainer, loaderHint, matchesLoaderPattern, withoutQueryValues, parseGtmOverride, parseTestGtmOrigin, previewFetchUrl, testOriginUrl } from './gtm-override.ts';

const valid = { container: 'GTM-PWTEST1', gtmAuth: 'pwfake-auth-0001', gtmPreview: 'env-99' };

test('the matcher takes gtm.js with the container id and ignores other parameters', () => {
  for (const url of [
    'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1',
    'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=dataLayer',
    'https://www.googletagmanager.com/gtm.js?l=dataLayer&id=GTM-PWTEST1&gtm_auth=x',
    'https://WWW.googletagmanager.com:443/gtm.js?id=GTM-PWTEST1',
  ]) {
    expect(matchesGtmContainer(url, 'GTM-PWTEST1'), url).toBe(true);
  }
});

test('the matcher refuses other containers, paths, hosts and schemes', () => {
  for (const url of [
    'https://www.googletagmanager.com/gtm.js?id=GTM-OTHER',
    'https://www.googletagmanager.com/gtm.js',
    'https://www.googletagmanager.com/gtag/js?id=GTM-PWTEST1',
    'https://www.googletagmanager.com/ns.html?id=GTM-PWTEST1',
    'https://www.googletagmanager.com/gtm.js/extra?id=GTM-PWTEST1',
    'https://googletagmanager.com/gtm.js?id=GTM-PWTEST1',
    'https://www.googletagmanager.com.example.com/gtm.js?id=GTM-PWTEST1',
    'http://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1',
    'https://example.com/gtm.js?id=GTM-PWTEST1',
    'not a url',
  ]) {
    expect(matchesGtmContainer(url, 'GTM-PWTEST1'), url).toBe(false);
  }
  expect(isGtmJsUrl('https://www.googletagmanager.com/gtm.js?id=GTM-OTHER')).toBe(true);
});

test('the preview fetch URL is exact when no test origin is set', () => {
  expect(previewFetchUrl(valid)).toBe(
    'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&gtm_auth=pwfake-auth-0001&gtm_preview=env-99&gtm_cookies_win=x',
  );
});

test('the test origin replaces the GTM origin in the fetch URL, and keeps the page query for a plain fetch', () => {
  expect(previewFetchUrl(valid, 'http://127.0.0.1:4000')).toBe(
    'http://127.0.0.1:4000/gtm.js?id=GTM-PWTEST1&gtm_auth=pwfake-auth-0001&gtm_preview=env-99&gtm_cookies_win=x',
  );
  expect(testOriginUrl('https://www.googletagmanager.com/gtm.js?id=GTM-A&l=dl', 'http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000/gtm.js?id=GTM-A&l=dl');
});

test('the test origin accepts loopback hosts over http, with or without a port', () => {
  expect(parseTestGtmOrigin(undefined)).toBeUndefined();
  expect(parseTestGtmOrigin('')).toBeUndefined();
  expect(parseTestGtmOrigin('http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
  expect(parseTestGtmOrigin('http://localhost:4000/')).toBe('http://localhost:4000');
  expect(parseTestGtmOrigin('http://localhost')).toBe('http://localhost');
  expect(parseTestGtmOrigin('http://[::1]:4000')).toBe('http://[::1]:4000');
});

test('the test origin rejects anything else', () => {
  for (const value of [
    'http://127.0.0.1.example.com',
    'http://localhost.example.com:80',
    'http://example.com',
    'http://127.0.0.2',
    'https://127.0.0.1:4000',
    'http://127.0.0.1:4000/path',
    'http://127.0.0.1:4000/?a=1',
    'http://127.0.0.1:4000?',
    'http://127.0.0.1:4000/#x',
    'http://user@127.0.0.1:4000',
    'http://user:pw@127.0.0.1:4000',
    'http://127.0.0.1@example.com',
    '127.0.0.1:4000',
    'nonsense',
  ]) {
    expect(() => parseTestGtmOrigin(value), value).toThrow(/PINGWRIGHT_TEST_GTM_ORIGIN/);
  }
});

test('container validation', () => {
  expect(parseGtmOverride(valid).container).toBe('GTM-PWTEST1');
  for (const container of ['gtm-pwtest1', 'GTM-', 'GTM-ab', 'GTM-A B', 'XYZ-A1', '', 7, undefined]) {
    expect(() => parseGtmOverride({ ...valid, container })).toThrow(/container must/);
  }
});

test('the other fields are validated and expectedTags default to an empty list', () => {
  expect(parseGtmOverride(valid).expectedTags).toEqual([]);
  expect(parseGtmOverride({ ...valid, expectedTags: [{ id: '45', name: 'GA4 - Purchase' }, { id: '46' }] }).expectedTags).toEqual([
    { id: '45', name: 'GA4 - Purchase' },
    { id: '46', name: null },
  ]);
  expect(() => parseGtmOverride({ ...valid, gtmAuth: '' })).toThrow(/gtmAuth/);
  expect(() => parseGtmOverride({ ...valid, gtmAuth: 'a b' })).toThrow(/gtmAuth/);
  expect(() => parseGtmOverride({ ...valid, gtmPreview: 'env-x' })).toThrow(/gtmPreview/);
  expect(() => parseGtmOverride({ ...valid, expectedTags: [{ name: 'x' }] })).toThrow(/expectedTags\[0\]/);
  expect(() => parseGtmOverride({ ...valid, extra: 1 })).toThrow(/unknown fields/);
  expect(() => parseGtmOverride([])).toThrow(/JSON object/);
});

test('validation errors never repeat the auth value', () => {
  expect(() => parseGtmOverride({ ...valid, container: 'bad', gtmPreview: 'bad' })).toThrow(/^(?!.*pwfake-auth-0001)/s);
});

test('loader accepts replace, match or both, and refuses an empty or bad one', () => {
  expect(parseGtmOverride({ ...valid, loader: { match: '/x-[a-z]+\\.js' } }).loader).toEqual({ match: '/x-[a-z]+\\.js' });
  expect(parseGtmOverride({ ...valid, loader: { replace: 'https://load.example.com/a.js?k=1', match: 'a' } }).loader).toEqual({
    replace: 'https://load.example.com/a.js?k=1',
    match: 'a',
  });
  for (const loader of [{}, { match: '' }, { match: '(' }, { match: 5 }, { other: 1 }]) {
    expect(() => parseGtmOverride({ ...valid, loader }), JSON.stringify(loader)).toThrow();
  }
});

test('the loader pattern is tested against the script URL', () => {
  expect(matchesLoaderPattern('https://load.example.com/abcd.js?x=1', 'script', { match: '/[a-z]+\\.js\\?' })).toBe(true);
  expect(matchesLoaderPattern('https://load.example.com/abcd.css', 'script', { match: '/[a-z]+\\.js\\?' })).toBe(false);
  expect(matchesLoaderPattern('https://load.example.com/abcd.js?x=1', 'script', {})).toBe(false);
  expect(matchesLoaderPattern('https://load.example.com/abcd.js?x=1', 'script', undefined)).toBe(false);
  for (const type of ['fetch', 'xhr', 'image', 'ping', 'beacon', 'other']) {
    expect(matchesLoaderPattern('https://load.example.com/data', type, { match: 'load\\.example\\.com' }), type).toBe(false);
  }
});

test('only scripts with a query on non-Google hosts are loader candidates', () => {
  expect(isLoaderCandidate('https://load.example.com/abcd.js?x=1', 'script')).toBe(true);
  expect(isLoaderCandidate('https://load.example.com/abcd.js', 'script')).toBe(false);
  expect(isLoaderCandidate('https://load.example.com/abcd.js?x=1', 'image')).toBe(false);
  expect(isLoaderCandidate('https://www.googletagmanager.com/gtag/js?id=G-X', 'script')).toBe(false);
  expect(isLoaderCandidate('https://load.example.com/abcd.php?x=1', 'script')).toBe(false);
});

test('the container check and the query-value hiding', () => {
  expect(bodyHasContainer('x google_tag_manager["GTM-PWTEST1"] y', 'GTM-PWTEST1')).toBe(true);
  expect(bodyHasContainer('nothing', 'GTM-PWTEST1')).toBe(false);
  expect(bodyHasContainer('x google_tag_manager["GTM-PWTEST1"] y', 'GTM-PWTEST')).toBe(false);
  expect(bodyHasContainer('google_tag_manager["GTM-PWTEST"]', 'GTM-PWTEST1')).toBe(false);
  expect(bodyHasContainer("(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-PWTEST1');", 'GTM-PWTEST1')).toBe(false);
  expect(bodyHasContainer('/* GTM-PWTEST1 */ window.google_tag_manager = {};', 'GTM-PWTEST1')).toBe(true);
  expect(withoutQueryValues('https://load.example.com/abcd.js?x9f=SECRET&x9f=2&b=3')).toBe('https://load.example.com/abcd.js?x9f=…&b=…');
});

test('loaderHint lists seen scripts without query values and points at firstPartyHosts for unchecked hosts', () => {
  const hint = loaderHint([], ['https://load.stape.example/abcd.js?k=SECRET']);
  expect(hint).toContain('https://load.stape.example/abcd.js?k=…');
  expect(hint).not.toContain('SECRET');
  expect(hint).toContain('"replace"');
  expect(hint).toContain('options.firstPartyHosts');
});

test('loaderHint skips the firstPartyHosts advice when every script was checked', () => {
  const url = 'https://load.example.com/abcd.js?k=1';
  expect(loaderHint([url], [url])).not.toContain('firstPartyHosts');
  expect(loaderHint([], [])).toContain('custom loader');
});

test('isLoaderHost covers the site domain, listed hosts and loopback only', () => {
  const site = 'https://www.shop.example.com/';
  expect(isLoaderHost('https://load.shop.example.com/a.js?k=1', site)).toBe(true);
  expect(isLoaderHost('https://shop.example.com/a.js?k=1', site)).toBe(true);
  expect(isLoaderHost('https://cdn.other.example/a.js?k=1', site)).toBe(false);
  expect(isLoaderHost('https://sgtm.other.example/a.js?k=1', site, ['*.other.example'])).toBe(true);
  expect(isLoaderHost('https://other.example/a.js?k=1', site, ['*.other.example'])).toBe(false);
  expect(isLoaderHost('http://localhost:4000/a.js?k=1', site)).toBe(false);
});

test('isLoaderHost treats a PSL private suffix as a boundary', () => {
  const site = 'https://a.myshopify.com/';
  expect(isLoaderHost('https://b.myshopify.com/a.js?k=1', site)).toBe(false);
  expect(isLoaderHost('https://cdn.a.myshopify.com/a.js?k=1', site)).toBe(true);
});

test('isLoaderHost on a loopback site accepts only loopback hosts', () => {
  const site = 'http://localhost:4173/';
  expect(isLoaderHost('http://127.0.0.1:4000/a.js?k=1', site)).toBe(true);
  expect(isLoaderHost('http://[::1]:4000/a.js?k=1', site)).toBe(true);
  expect(isLoaderHost('https://load.shop.example.com/a.js?k=1', site)).toBe(false);
  expect(isLoaderHost('https://load.shop.example.com/a.js?k=1', site, ['*.shop.example.com'])).toBe(false);
});

test('a script from the site origin is neither listed nor sniffed', () => {
  const site = 'https://shop.example.com/';
  expect(isCrossOriginLoaderCandidate('https://shop.example.com/metrics/abcd.js?k=x', 'script', site)).toBe(false);
  expect(isSniffableLoader('https://shop.example.com/metrics/abcd.js?k=x', 'script', site)).toBe(false);
  expect(isCrossOriginLoaderCandidate('https://load.shop.example.com/abcd.js?k=x', 'script', site)).toBe(true);
  expect(isSniffableLoader('https://load.shop.example.com/abcd.js?k=x', 'script', site)).toBe(true);
  expect(isCrossOriginLoaderCandidate('https://cdn.other.example/abcd.js?k=x', 'script', site)).toBe(true);
  expect(isSniffableLoader('https://cdn.other.example/abcd.js?k=x', 'script', site)).toBe(false);
});
