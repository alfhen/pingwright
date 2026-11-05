import { describe, expect, test } from 'vitest';
import type { PushGroup } from './diff.ts';
import { diffPushes } from './diff.ts';
import { normalizePushGroups, parseEventMap } from './event-map.ts';

const group = (event: string, paths: string[] = []): PushGroup => ({ epoch: 'undecided', event, frame: 'main', paths: paths.map((path) => ({ path, types: ['string'] })) });

describe('parseEventMap', () => {
  test('reads events and paths', () => {
    const map = parseEventMap('{"events":{"a":"b"},"paths":{"b":{"x.y":"z"}}}', 'm.json');
    expect(map.events.a).toBe('b');
    expect(map.paths.b!['x.y']).toBe('z');
  });

  test('an empty object is a valid map', () => {
    const map = parseEventMap('{}', 'm.json');
    expect(Object.keys(map.events)).toEqual([]);
    expect(Object.keys(map.paths)).toEqual([]);
  });

  test.each([
    ['not json {', 'm.json: the event map is not valid JSON.'],
    ['[]', 'must be a JSON object'],
    ['{"rename":{}}', 'unknown key "rename"'],
    ['{"events":{"a":3}}', 'events.a must be an event name'],
    ['{"events":[]}', '"events" must be an object'],
    ['{"paths":{"b":{"x":"<script>"}}}', 'paths.b.x must be a key path'],
    ['{"paths":{"b":"x"}}', 'paths.b must be an object'],
  ])('rejects %s', (text, message) => {
    expect(() => parseEventMap(text, 'm.json')).toThrow(message);
  });

  test('an error names the file and the key and never a value', () => {
    for (const text of ['{"events":{"a":"secret-value-1 <"}}', '{"events":{"a":{"x":"secret-value-1"}}}', 'secret-value-1']) {
      expect(() => parseEventMap(text, 'm.json')).toThrow('m.json');
      expect(() => parseEventMap(text, 'm.json')).not.toThrow(/secret-value-1/);
    }
  });

  test('a prototype key does not reach the result', () => {
    const map = parseEventMap('{"events":{"__proto__":"x"}}', 'm.json');
    expect(Object.keys(map.events)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('normalizePushGroups', () => {
  test('applies the built-in table and leaves consent and gtag labels alone', () => {
    const out = normalizePushGroups([group('checkout_completed'), group('consent update'), group('gtag config'), group('constructor')]);
    expect(out.map((g) => g.event)).toEqual(['purchase', 'consent update', 'gtag config', 'constructor']);
  });

  test('a user map matches the recorded name first, then maps the result through the table', () => {
    const map = parseEventMap('{"events":{"checkout_completed":"custom","legacy":"checkout_completed"}}', 'm.json');
    expect(normalizePushGroups([group('checkout_completed'), group('legacy')], map).map((g) => g.event)).toEqual(['custom', 'purchase']);
  });

  test('a path rename covers the path, its children and array items, and only in the named event', () => {
    const map = parseEventMap('{"paths":{"purchase":{"ecommerce":"data"}}}', 'm.json');
    const out = normalizePushGroups([group('purchase', ['ecommerce', 'ecommerce.items[*].id', 'ecommerceX', 'value']), group('other', ['ecommerce'])], map);
    expect(out[0]!.paths.map((p) => p.path)).toEqual(['data', 'data.items[*].id', 'ecommerceX', 'value']);
    expect(out[1]!.paths.map((p) => p.path)).toEqual(['ecommerce']);
  });

  test('a rename to the root maps an object push to a gtag event push', () => {
    const map = parseEventMap('{"paths":{"purchase":{"ecommerce":"."}}}', 'm.json');
    const object = group('purchase', ['event', 'ecommerce.value', 'ecommerce.items[*].id']);
    const gtag = group('purchase', ['value', 'items[*].id']);
    expect(normalizePushGroups([object], map)[0]!.paths.map((p) => p.path)).toEqual(['value', 'items[*].id']);
    expect(diffPushes([object], [gtag], { eventMap: map }).changed).toBe(false);
    expect(diffPushes([object], [gtag]).changed).toBe(true);
  });

  test('a root rename drops the source path itself', () => {
    const map = parseEventMap('{"paths":{"purchase":{"ecommerce":"."}}}', 'm.json');
    expect(normalizePushGroups([group('purchase', ['event', 'ecommerce', 'ecommerce[*]'])], map)[0]!.paths.map((p) => p.path)).toEqual(['[*]']);
  });

  test('a rename from the root maps a gtag event push to an object push', () => {
    const map = parseEventMap('{"paths":{"purchase":{".":"ecommerce"}}}', 'm.json');
    const gtag = group('purchase', ['value', 'items[*].id', '[*]']);
    const object = group('purchase', ['event', 'ecommerce.value', 'ecommerce.items[*].id', 'ecommerce[*]']);
    expect(normalizePushGroups([gtag], map)[0]!.paths.map((p) => p.path).sort()).toEqual(['ecommerce.items[*].id', 'ecommerce.value', 'ecommerce[*]', 'event']);
    expect(diffPushes([gtag], [object], { eventMap: map }).changed).toBe(false);
    expect(diffPushes([gtag], [object]).changed).toBe(true);
  });

  test('a root to root rename is rejected', () => {
    expect(() => parseEventMap('{"paths":{"purchase":{".":"."}}}', 'm.json')).toThrow('paths.purchase');
  });
});
