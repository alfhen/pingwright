import { describe, expect, it } from 'vitest';
import { classifyForward, forwardList } from './forward-list.ts';

const table: ReadonlyArray<[string, string, string | undefined]> = [
  ['GET', 'https://www.googletagmanager.com/server.js?id=GTM-PWTEST1&gtm_auth=fake', 'config'],
  ['HEAD', 'https://www.googletagmanager.com/server.js', 'config'],
  ['GET', 'https://www.googletagmanager.com/static/serverjs/abc/runtime.js', 'serverjs'],
  ['GET', 'https://www.googletagmanager.com/s/gtag/destination?id=G-PWTEST0001', 'destination'],
  ['GET', 'https://www.googletagmanager.com:443/server.js', 'config'],
  ['GET', 'https://WWW.GoogleTagManager.com/server.js', 'config'],
  ['GET', 'https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1', undefined],
  ['GET', 'https://www.googletagmanager.com/gtag/js?id=G-PWTEST0001', undefined],
  ['GET', 'https://www.googletagmanager.com/a', undefined],
  ['GET', 'https://www.googletagmanager.com/server.js/..', undefined],
  ['GET', 'https://www.googletagmanager.com/static/serverjs/../gtm.js', undefined],
  ['GET', 'https://www.googletagmanager.com/static/serverjs/%2e%2e/gtm.js', undefined],
  ['GET', 'https://www.googletagmanager.com/static/serverjs', undefined],
  ['GET', 'https://www.googletagmanager.com/server.js/x', undefined],
  ['GET', 'https://www.googletagmanager.com:8443/server.js?x=1', undefined],
  ['GET', 'http://www.googletagmanager.com/server.js', undefined],
  ['GET', 'https://googletagmanager.com/server.js', undefined],
  ['GET', 'https://www.googletagmanager.com.evil.invalid/server.js', undefined],
  ['GET', 'https://WWW.GOOGLETAGMANAGER.COM.evil.invalid/server.js', undefined],
  ['POST', 'https://www.googletagmanager.com/server.js', undefined],
];

describe('classifyForward', () => {
  it.each(table)('%s %s', (method, url, expected) => {
    expect(classifyForward(method, new URL(url))).toBe(expected);
  });

  it('lists exactly three rows, all on www.googletagmanager.com', () => {
    expect(forwardList.map((r) => [r.class, r.host, r.path, r.match])).toEqual([
      ['serverjs', 'www.googletagmanager.com', '/static/serverjs/', 'prefix'],
      ['config', 'www.googletagmanager.com', '/server.js', 'exact'],
      ['destination', 'www.googletagmanager.com', '/s/gtag/destination', 'exact'],
    ]);
  });
});
