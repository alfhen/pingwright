import { expect, test } from 'vitest';
import { parseCollectorBody, parseCollectorRequest, routeCollector } from './collector.ts';

test('a GET report is kept as an invalid report with its URL', () => {
  const url = 'https://collector.pingwright.invalid/pixel.gif?source=x';
  expect(parseCollectorRequest('GET', url, null)).toEqual({
    parsed: { ok: false, error: 'GET request, reports must be POST' },
    body: url,
  });
});

test('a POST report is parsed', () => {
  expect(parseCollectorRequest('POST', 'https://collector.pingwright.invalid/r', '{"source":"a"}').parsed).toMatchObject({
    ok: true,
    source: 'a',
  });
});

test.each([
  ['GET', 1],
  ['POST', 1],
  ['OPTIONS', 0],
])('routeCollector hands a %s request to the handler %i times and answers 204', async (method, calls) => {
  let routeHandler: ((route: unknown) => Promise<void>) | undefined;
  const context = { route: (_pattern: string, handler: typeof routeHandler) => ((routeHandler = handler), Promise.resolve()) };
  const seen: unknown[] = [];
  const fulfilled: unknown[] = [];
  await routeCollector(context as never, () => (parsed) => seen.push(parsed), () => 1);
  await routeHandler!({
    request: () => ({
      method: () => method,
      url: () => 'https://collector.pingwright.invalid/r',
      postData: () => '{"source":"a"}',
      headers: () => ({}),
    }),
    fulfill: (options: unknown) => {
      fulfilled.push(options);
      return Promise.resolve();
    },
  });
  expect(seen).toHaveLength(calls);
  expect(fulfilled).toMatchObject([{ status: 204 }]);
});

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
