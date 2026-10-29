import { expect, test } from 'vitest';
import { parseCollectorBody } from './collector.ts';

test('accepts a JSON object with a source', () => {
  expect(parseCollectorBody('{"source":"fixture-pixel","event":"page_viewed"}')).toEqual({
    ok: true,
    source: 'fixture-pixel',
    payload: { source: 'fixture-pixel', event: 'page_viewed' },
  });
});

test.each([
  ['', 'empty body'],
  ['not json', 'body is not JSON'],
  ['[1]', 'body must be a JSON object'],
  ['null', 'body must be a JSON object'],
  ['{"event":"x"}', '"source" must be a string of 1 to 64 characters'],
  ['{"source":""}', '"source" must be a string of 1 to 64 characters'],
  ['{"source":5}', '"source" must be a string of 1 to 64 characters'],
  [`{"source":"${'a'.repeat(65)}"}`, '"source" must be a string of 1 to 64 characters'],
  [`{"source":"x","pad":"${'a'.repeat(70_000)}"}`, 'body over 65536 bytes'],
])('rejects %#', (body, error) => {
  expect(parseCollectorBody(body)).toEqual({ ok: false, error });
});

test('a missing body is invalid', () => {
  expect(parseCollectorBody(null)).toEqual({ ok: false, error: 'empty body' });
});
