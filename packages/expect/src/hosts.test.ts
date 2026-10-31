import { describe, expect, test } from 'vitest';
import { isSpecificServerHost } from './hosts.ts';

describe('isSpecificServerHost', () => {
  test.each(['*.police.uk', '*.uk.com', '*.fly.dev', '*.onrender.com', '*.s3.amazonaws.com', '*.foo.kawasaki.jp', '*.kawasaki.jp', '*.compute.amazonaws.com'])('rejects %s, a public suffix the old rule missed', (pattern) => {
    expect(isSpecificServerHost(pattern)).toBe(false);
  });

  test.each(['*.abc.de', '*.xyz.io', '*.city.kawasaki.jp'])('accepts %s, which is not a public suffix', (pattern) => {
    expect(isSpecificServerHost(pattern)).toBe(true);
  });

  test.each([
    'myshopify.com',
    'github.io',
    'herokuapp.com',
    'vercel.app',
    'netlify.app',
    'pages.dev',
    'workers.dev',
    'web.app',
    'firebaseapp.com',
    'blogspot.com',
    'wordpress.com',
    'wixsite.com',
    'azurewebsites.net',
    'cloudfront.net',
    'appspot.com',
    'co.kr',
    'com.au',
    'co.uk',
    'com',
  ])('rejects *.%s', (suffix) => {
    expect(isSpecificServerHost(`*.${suffix}`)).toBe(false);
  });

  test.each(['*.shop.example.com', '*.sgtm.example.com', 'sgtm.example.com', 'localhost', '127.0.0.1', '::1'])('accepts %s', (pattern) => {
    expect(isSpecificServerHost(pattern)).toBe(true);
  });

  test('accepts an exact host on a shared suffix, and a wildcard under one', () => {
    expect(isSpecificServerHost('sgtm.wordpress.com')).toBe(true);
    expect(isSpecificServerHost('*.shop.myshopify.com')).toBe(true);
  });

  test('still rejects vendor hosts', () => {
    expect(isSpecificServerHost('*.google-analytics.com')).toBe(false);
  });
});
