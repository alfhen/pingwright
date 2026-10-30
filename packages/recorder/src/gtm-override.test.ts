import { expect, test } from 'vitest';
import { isGtmJsUrl, matchesGtmContainer, parseGtmOverride, parseTestGtmOrigin, previewFetchUrl, testOriginUrl } from './gtm-override.ts';

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
