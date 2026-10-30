import { expect, test } from 'vitest';
import { globToRegExp } from './glob.ts';

test('star matches zero or more characters', () => {
  const re = globToRegExp('cookie*');
  expect(re.test('cookie')).toBe(true);
  expect(re.test('cookie_data')).toBe(true);
  expect(re.test('mycookie')).toBe(false);
  expect(globToRegExp('a*b*c').test('abc')).toBe(true);
});

test('regex characters in the pattern are literal', () => {
  const re = globToRegExp('ud[*]');
  expect(re.test('ud[em]')).toBe(true);
  expect(re.test('udx')).toBe(false);
  expect(globToRegExp('a.b').test('axb')).toBe(false);
  expect(globToRegExp('a+b(c)').test('a+b(c)')).toBe(true);
});
