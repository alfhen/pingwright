import { expect, test } from 'vitest';
import { idKind, idPrefixes, isId, newId, ulid, type IdKind } from './ids.ts';

test('every kind has its prefix and a 26-character Crockford suffix', () => {
  for (const kind of Object.keys(idPrefixes) as IdKind[]) {
    const id = newId(kind);
    expect(id).toMatch(new RegExp(`^${idPrefixes[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`));
    expect(isId(id, kind)).toBe(true);
    expect(idKind(id)).toBe(kind);
  }
  expect(Object.values(idPrefixes).sort()).toEqual(
    ['ckp', 'cep', 'dle', 'flg', 'hit', 'req', 'res', 'rpt', 'rsl', 'run', 'stp', 'tag'].sort(),
  );
});

test('ids sort by creation time, including inside one millisecond', () => {
  const ids = Array.from({ length: 5000 }, () => ulid(1_800_000_000_000));
  expect([...ids].sort()).toEqual(ids);
  expect(new Set(ids).size).toBe(ids.length);
});

test('later milliseconds sort after earlier ones', () => {
  const a = ulid(1_800_000_100_000);
  const b = ulid(1_800_000_100_001);
  expect(a < b).toBe(true);
});

test('a clock step back keeps ids increasing', () => {
  const a = ulid(1_800_000_200_000);
  const b = ulid(1_800_000_100_000);
  expect(a < b).toBe(true);
});

test('isId rejects malformed values', () => {
  expect(isId('req_short')).toBe(false);
  expect(isId('zzz_' + '0'.repeat(26))).toBe(false);
  expect(isId(newId('hit'), 'request')).toBe(false);
  expect(isId(42)).toBe(false);
});

test('idKind returns undefined without a separator', () => {
  expect(idKind('runx')).toBeUndefined();
  expect(idKind('hitZ')).toBeUndefined();
});
