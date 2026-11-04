import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { standInContainerPath } from '../fixtures/site/src/index.ts';
import { run, type CliRun } from './cli-helpers.ts';

const AUTH = 'pw-fixture-auth';
const CONFIG = Buffer.from(`id=GTM-PWTEST1&env=1&auth=${AUTH}`).toString('base64');
const GOOGLE_HOST = 'www.google-analytics.com';

let upstream: http.Server;
let env: Record<string, string>;

beforeAll(async () => {
  upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('// fake google file'));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  env = {
    TAGREEVE_TEST_SERVER_CONTAINER_CMD: standInContainerPath,
    TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG,
  };
});

afterAll(async () => {
  await new Promise((resolve) => upstream?.close(resolve));
});

const resultsOf = (r: CliRun) => (JSON.parse(r.stdout) as { results: { expectation: string; pass: boolean }[] }).results;
const failedRules = (r: CliRun) => resultsOf(r).filter((x) => !x.pass && !x.expectation.startsWith('builtin: ')).map((x) => x.expectation);
const ruleResult = (r: CliRun, kind: 'must' | 'mustNot', pattern: RegExp) => {
  const found = resultsOf(r).filter((x) => x.expectation.startsWith(`${kind}: `) && pattern.test(x.expectation));
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe('sentBy with the stand-in container', () => {
  let withSentBy: CliRun;

  beforeAll(async () => {
    withSentBy = await run('sent-by', ['--server-container'], env);
  }, 120_000);

  test('the record holds one browser GA4 hit to the loopback host, one container GA4 hit to Google and no browser request to Google', () => {
    const records = withSentBy.records!;
    const ga4 = records.hits.filter((h) => h.vendor === 'ga4');
    const requestOf = (id: string) => records.requests.find((r) => r.id === id)!;
    const container = ga4.filter((h) => requestOf(h.requestId).captured === 'serverContainer');
    const browser = ga4.filter((h) => requestOf(h.requestId).captured !== 'serverContainer');
    expect(container).toHaveLength(1);
    expect(new URL(requestOf(container[0]!.requestId).url).hostname).toBe(GOOGLE_HOST);
    expect(browser).toHaveLength(1);
    expect(new URL(requestOf(browser[0]!.requestId).url).hostname).toBe('127.0.0.1');
    expect(records.requests.filter((r) => r.captured !== 'serverContainer' && new URL(r.url).hostname === GOOGLE_HOST)).toEqual([]);
  });

  test('every sentBy rule passes', () => {
    expect(ruleResult(withSentBy, 'must', /127\.0\.0\.1.*"sentBy":"browser"/).pass).toBe(true);
    expect(ruleResult(withSentBy, 'mustNot', /127\.0\.0\.1.*"sentBy":"server"/).pass).toBe(true);
    expect(ruleResult(withSentBy, 'mustNot', /google-analytics.*"sentBy":"browser"/).pass).toBe(true);
    expect(ruleResult(withSentBy, 'must', /google-analytics.*"sentBy":"server"/).pass).toBe(true);
    expect(failedRules(withSentBy)).toEqual([]);
  });

  test('the same Google-host mustNot without sentBy fails on the container call and nothing else fails', async () => {
    const both = await run('sent-by-both', ['--server-container'], env);
    expect(both.code).toBe(1);
    expect(failedRules(both)).toHaveLength(1);
    expect(failedRules(both)[0]).toMatch(/^mustNot: .*google-analytics/);
  }, 120_000);

  test('no output holds the container config or its auth value', async () => {
    const path = (JSON.parse(withSentBy.stdout) as { path: string }).path;
    const text = (await readFile(path, 'utf8')) + withSentBy.stdout + withSentBy.stderr;
    for (const secret of [CONFIG, AUTH]) expect(text).not.toContain(secret);
  });
});
