import { expect, test } from 'vitest';
import { parseTrackerList, trackerDocsDomains, trackerFor, trackerList } from './index.ts';

const at = (url: string) => trackerFor({ url });

test('matches an exact host with any path when the entry has no paths', () => {
  expect(at('https://alb.reddit.com/rp.gif?id=x')?.vendor).toBe('reddit');
});

test('matches a path prefix', () => {
  expect(at('https://bat.bing.com/action/0?ti=1')?.vendor).toBe('microsoft-uet');
  expect(at('https://tr.snapchat.com/v3/100/events')?.vendor).toBe('snap');
});

test('does not match another path on a listed host', () => {
  expect(at('https://bat.bing.com/action/01')).toBeUndefined();
  expect(at('https://tr.snapchat.com/v30/events')).toBeUndefined();
});

test('does not match library loads', () => {
  expect(at('https://bat.bing.com/bat.js')).toBeUndefined();
  expect(at('https://sc-static.net/scevent.min.js')).toBeUndefined();
  expect(at('https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=X&lib=ttq')).toBeUndefined();
});

test('does not match an unlisted host or a bad URL', () => {
  expect(at('https://example.com/action/0')).toBeUndefined();
  expect(at('https://bat.bing.com.example.com/action/0')).toBeUndefined();
  expect(at('not a url')).toBeUndefined();
});

test('every vendor key is present and every source is https on its docs domains', () => {
  expect(new Set(trackerList.map((e) => e.vendor))).toEqual(new Set(Object.keys(trackerDocsDomains)));
  for (const e of trackerList) {
    const u = new URL(e.source);
    const ok = trackerDocsDomains[e.vendor]!.some((d) => u.hostname === d || u.hostname.endsWith(`.${d}`));
    expect(u.protocol, e.source).toBe('https:');
    expect(ok, `${e.vendor}: ${e.source}`).toBe(true);
  }
});

test('wildcard hosts match subdomains only', () => {
  const list = parseTrackerList([{ vendor: 'acme', host: '*.acme.example.com', source: 'https://docs.example.com/a' }]);
  expect(trackerFor({ url: 'https://px.acme.example.com/x' }, list)?.vendor).toBe('acme');
  expect(trackerFor({ url: 'https://acme.example.com/x' }, list)).toBeUndefined();
});

test('parses a valid user list', () => {
  const entry = { vendor: 'acme', host: 't.example.com', paths: ['/c'], source: 'https://docs.example.com/a' };
  expect(parseTrackerList([entry])).toEqual([entry]);
});

const ok = { vendor: 'a', host: 't.example.com', source: 'https://d.example.com' };

test.each([
  [{}, 'must be a JSON array'],
  [['x'], 'entry 0: must be an object'],
  [[{ host: ok.host, source: ok.source }], '"vendor"'],
  [[{ ...ok, host: 'T.example.com' }], '"host"'],
  [[{ ...ok, host: 'localhost' }], '"host"'],
  [[{ ...ok, paths: ['c'] }], '"paths"'],
  [[{ ...ok, paths: [] }], '"paths"'],
  [[{ ...ok, source: 'http://d.example.com' }], '"source"'],
  [[{ vendor: ok.vendor, host: ok.host }], '"source"'],
  [[{ ...ok, x: 1 }], 'unknown field "x"'],
])('rejects an invalid list %#', (json, message) => {
  expect(() => parseTrackerList(json)).toThrow(message);
});
