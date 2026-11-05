import { newId, type Request } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { buildDataLayerNotHookedFlag, loaderLayerName } from './datalayer-names.ts';

const runId = newId('run');
const req = (url: string): Request => ({ id: newId('request'), url }) as unknown as Request;
const b64 = (text: string) => Buffer.from(text).toString('base64');

test('reads l= from gtm.js and gtag/js', () => {
  expect(loaderLayerName(req('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=myLayer'))).toBe('myLayer');
  expect(loaderLayerName(req('https://www.googletagmanager.com/gtag/js?id=G-PWTEST0001&l=other'))).toBe('other');
  expect(loaderLayerName(req('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1'))).toBeUndefined();
  expect(loaderLayerName(req('https://shop.example/app.js?l=myLayer'))).toBeUndefined();
  expect(loaderLayerName(req('not a url'))).toBeUndefined();
});

test('reads l= from a decoded Stape loader URL', () => {
  const path = '/gtm.js?id=GTM-PWTEST1&l=stapeLayer';
  expect(loaderLayerName(req(`https://sgtm.example.test/pwstape?pk=${encodeURIComponent(b64(path))}`))).toBe('stapeLayer');
});

test('no flag when the name is hooked, is dataLayer or is absent', () => {
  const requests = [req('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=myLayer'), req('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=dataLayer')];
  expect(buildDataLayerNotHookedFlag({ runId, requests, hooked: ['myLayer'] })).toBeUndefined();
  expect(buildDataLayerNotHookedFlag({ runId, requests: [], hooked: [] })).toBeUndefined();
});

test('one flag per run names the option and the layer, on each loader kind', () => {
  const gtm = req('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=myLayer');
  const gtag = req('https://www.googletagmanager.com/gtag/js?id=G-PWTEST0001&l=myLayer');
  const stape = req(`https://sgtm.example.test/pwstape?pk=${encodeURIComponent(b64('/gtm.js?id=GTM-PWTEST1&l=myLayer'))}`);
  for (const r of [gtm, gtag, stape]) {
    const flag = buildDataLayerNotHookedFlag({ runId, requests: [r], hooked: [] });
    expect(flag).toMatchObject({ kind: 'dataLayerNotHooked', recordIds: [r.id] });
    expect(flag?.detail).toContain('options.dataLayerNames');
    expect(flag?.detail).toContain('"myLayer"');
  }
  const flag = buildDataLayerNotHookedFlag({ runId, requests: [gtm, gtag, stape], hooked: [] });
  expect(flag?.recordIds).toHaveLength(3);
});

test('a name that is not an identifier shows as (other)', () => {
  const flag = buildDataLayerNotHookedFlag({ runId, requests: [req('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=a%20b%40example.test')], hooked: [] });
  expect(flag?.detail).toContain('(other)');
  expect(flag?.detail).not.toContain('example.test');
});

test.each([
  ['a checkout token', 'c0ffee00c0ffee00c0ffee00c0ffee00'],
  ['an email', 'pw.test@example.test'],
  ['a Shopify GID', 'gid://shopify/Customer/1234567890'],
])('the flag detail never holds %s from l=', (_label, value) => {
  const r = req(`https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1&l=${encodeURIComponent(value)}`);
  expect(loaderLayerName(r)).toBe(value);
  const flag = buildDataLayerNotHookedFlag({ runId, requests: [r], hooked: [] });
  expect(flag?.detail).toContain('(other)');
  expect(flag?.detail).not.toContain(value);
});
