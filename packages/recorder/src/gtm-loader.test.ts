import { expect, test } from 'vitest';
import { matchesLoaderContainer, parseGtmOverride } from './gtm-override.ts';

const valid = { container: 'GTM-PWTEST1', gtmAuth: 'pwfake-auth-0001', gtmPreview: 'env-99' };

test('the loader matcher takes an inner /gtm.js with the container id on any host', () => {
  expect(matchesLoaderContainer('http://127.0.0.1:4000/gtm.js?id=GTM-PWTEST1', 'GTM-PWTEST1')).toBe(true);
  expect(matchesLoaderContainer('http://127.0.0.1:4000/gtm.js?id=GTM-OTHER', 'GTM-PWTEST1')).toBe(false);
  expect(matchesLoaderContainer('http://127.0.0.1:4000/gtag/js?id=GTM-PWTEST1', 'GTM-PWTEST1')).toBe(false);
  expect(matchesLoaderContainer('nonsense', 'GTM-PWTEST1')).toBe(false);
});

test('loader.replace is validated and normalised', () => {
  expect(parseGtmOverride(valid).loader).toBeUndefined();
  expect(parseGtmOverride({ ...valid, loader: { replace: 'https://sgtm.example.com/abc?pk=x' } }).loader).toEqual({ replace: 'https://sgtm.example.com/abc?pk=x' });
  for (const loader of ['x', [], {}, { replace: 7 }, { replace: 'not a url' }, { replace: 'ftp://example.com/a' }, { replace: 'https://example.com/a', extra: 1 }]) {
    expect(() => parseGtmOverride({ ...valid, loader }), JSON.stringify(loader)).toThrow(/loader/);
  }
});
