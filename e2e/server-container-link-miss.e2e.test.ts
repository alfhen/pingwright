import { readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Hit, type HitLinkMiss, type RunRecords } from '../packages/core/src/index.ts';
import { standInContainerPath } from '../fixtures/site/src/index.ts';
import { run, type CliRun } from './cli-helpers.ts';

const CONFIG = Buffer.from('id=GTM-PWTEST1&env=1&auth=pw-fixture-auth').toString('base64');
const IDS = ['pw-client-none-1', 'pw-client-same-1', 'pw-eid-several-1', 'pw-event-1', 'pw-client.1'];

interface NotExact {
  eventId: Record<HitLinkMiss['eventId'], number>;
  clientId: Record<HitLinkMiss['clientId'], number>;
}

let upstream: http.Server;
let result: CliRun;
let records: RunRecords;

beforeAll(async () => {
  upstream = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('// fake google file'));
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const env = {
    TAGREEVE_TEST_SERVER_CONTAINER_CMD: standInContainerPath,
    TAGREEVE_TEST_SERVER_CONTAINER_UPSTREAM: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    TAGREEVE_SERVER_CONTAINER_CONFIG: CONFIG,
  };
  result = await run('server-container-link-miss', ['--server-container'], env);
  records = result.records!;
}, 180_000);

afterAll(async () => {
  await new Promise((resolve) => upstream?.close(resolve));
});

const containerRequests = () => new Set(records.requests.filter((r) => r.captured === 'serverContainer').map((r) => r.id));

function containerGa4(event: string): Hit[] {
  const fromContainer = containerRequests();
  return records.hits.filter((h) => h.vendor === 'ga4' && h.event === event && fromContainer.has(h.requestId)).sort((a, b) => a.t - b.t);
}

function browserGa4(event: string): Hit[] {
  const fromContainer = containerRequests();
  return records.hits.filter((h) => h.vendor === 'ga4' && h.event === event && !fromContainer.has(h.requestId));
}

describe('why a container call is not exact', () => {
  test('the precondition holds: every case has its browser hits and container calls in the record', () => {
    expect(browserGa4('link_none')).toHaveLength(1);
    expect(browserGa4('link_nomatch')).toHaveLength(1);
    expect(browserGa4('link_several')).toHaveLength(2);
    expect(browserGa4('link_samekey')).toHaveLength(2);
    expect(containerGa4('link_none')).toHaveLength(1);
    expect(containerGa4('link_nomatch')).toHaveLength(1);
    expect(containerGa4('link_several')).toHaveLength(2);
    expect(containerGa4('link_samekey')).toHaveLength(2);
  });

  test('a call with no event ID, answered before, is none and answeredBefore', () => {
    expect(containerGa4('link_none')[0]!.linkMiss).toEqual({ eventId: 'none', clientId: 'answeredBefore' });
  });

  test('a call with an event ID no browser hit carries, and the fixed client ID, is noMatch and noSameKeyHit', () => {
    expect(containerGa4('link_nomatch')[0]!.linkMiss).toEqual({ eventId: 'noMatch', clientId: 'noSameKeyHit' });
  });

  test('an event ID two browser hits carry is several', () => {
    for (const call of containerGa4('link_several')) expect(call.linkMiss).toMatchObject({ eventId: 'several' });
  });

  test('two hits with one client ID and event name make the second call severalSameKeyHits, and the first stays exact', () => {
    const [first, second] = containerGa4('link_samekey');
    expect(first!.via).toMatchObject({ by: 'clientId', confidence: 'exact' });
    expect(first!.linkMiss).toBeUndefined();
    expect(second!.linkMiss).toEqual({ eventId: 'none', clientId: 'severalSameKeyHits' });
  });

  test('--json serverContainer.notExact counts every container hit that is not exact', () => {
    const summary = JSON.parse(result.stdout) as { serverContainer: { calls: number; exact: number; notExact: NotExact } };
    const sent = records.hits.filter((h) => containerRequests().has(h.requestId));
    const missed = sent.filter((h) => h.linkMiss);
    expect(summary.serverContainer.calls).toBe(sent.length);
    expect(missed.length).toBe(sent.length - summary.serverContainer.exact);
    const sum = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum(summary.serverContainer.notExact.eventId)).toBe(missed.length);
    expect(sum(summary.serverContainer.notExact.clientId)).toBe(missed.length);
    expect(summary.serverContainer.notExact.eventId.none).toBe(missed.filter((h) => h.linkMiss!.eventId === 'none').length);
    expect(summary.serverContainer.notExact.eventId.several).toBeGreaterThanOrEqual(2);
    expect(summary.serverContainer.notExact.eventId.noMatch).toBeGreaterThanOrEqual(1);
    expect(summary.serverContainer.notExact.clientId.severalSameKeyHits).toBeGreaterThanOrEqual(1);
    expect(summary.serverContainer.notExact.clientId.answeredBefore).toBeGreaterThanOrEqual(1);
  });

  test('no client ID, event ID or URL is in notExact or in the link reasons', async () => {
    const summary = JSON.parse(result.stdout) as { serverContainer: { notExact: NotExact } };
    const text = JSON.stringify(summary.serverContainer.notExact) + JSON.stringify(records.hits.map((h) => h.linkMiss ?? null));
    for (const id of IDS) expect(text).not.toContain(id);
    expect(text).not.toMatch(/https?:/);
    const record = await readFile((JSON.parse(result.stdout) as { path: string }).path, 'utf8');
    for (const id of IDS) {
      expect(record).toContain(id);
      expect(result.stdout).not.toContain(id);
      expect(result.stderr).not.toContain(id);
    }
    const all = record + result.stdout + result.stderr;
    expect(all).not.toContain(CONFIG);
    expect(all).not.toContain('pw-fixture-auth');
  });
});
