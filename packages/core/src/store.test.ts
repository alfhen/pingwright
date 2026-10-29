import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newId } from './ids.ts';
import type { Flag, Hit, Request, Run } from './records.ts';
import { RunWriter, readRun } from './store.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pingwright-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeRun(): Run {
  return {
    type: 'run',
    id: newId('run'),
    scenario: 'checkout',
    site: 'http://localhost:1234',
    startedAt: 1_800_000_000_000,
    pingwrightVersion: '0.0.0',
    browser: { name: 'chromium', version: '156.0.0.0' },
    networkMode: 'stub',
    gtmOverride: null,
    containerVersions: {},
    identity: null,
  };
}

function makeRequest(run: Run, i: number): Request {
  return {
    type: 'request',
    id: newId('request'),
    runId: run.id,
    stepId: null,
    t: 1_800_000_000_000 + i,
    method: 'GET',
    url: `https://example.com/${i}`,
    resourceType: 'fetch',
    frameUrl: null,
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
  };
}

test('round trips records, grouped by type, with the run on the first line', async () => {
  const run = makeRun();
  const writer = await RunWriter.create(dir, run);
  const req = makeRequest(run, 1);
  const hit: Hit = {
    type: 'hit',
    id: newId('hit'),
    runId: run.id,
    stepId: null,
    requestId: req.id,
    t: req.t,
    vendor: 'ga4',
    event: 'purchase',
    consent: {
      analytics: 'denied',
      ads: 'denied',
      adUserData: 'unknown',
      adPersonalization: 'unknown',
      raw: { gcs: 'G100' },
    },
    ids: { user_id: true },
    page: 'http://localhost:1234/thanks',
    transport: 'POST',
    params: {},
  };
  const flag: Flag = {
    type: 'flag',
    id: newId('flag'),
    runId: run.id,
    kind: 'unknownDestination',
    recordIds: [req.id],
    detail: 'unknown host',
  };
  await writer.append(req);
  await writer.append(hit);
  await writer.append(flag);
  await writer.close();

  const lines = (await readFile(writer.path, 'utf8')).trimEnd().split('\n');
  expect(lines).toHaveLength(4);
  expect(JSON.parse(lines[0]!).type).toBe('run');

  const loaded = await readRun(writer.path);
  expect(loaded.run).toEqual(run);
  expect(loaded.requests).toEqual([req]);
  expect(loaded.hits).toEqual([hit]);
  expect(loaded.flags).toEqual([flag]);
  expect(loaded.steps).toEqual([]);
});

test('streams many concurrent appends without losing or interleaving lines', async () => {
  const run = makeRun();
  const writer = await RunWriter.create(dir, run);
  const reqs = Array.from({ length: 3000 }, (_, i) => makeRequest(run, i));
  await Promise.all(reqs.map((r) => writer.append(r)));
  await writer.close();
  const loaded = await readRun(writer.path);
  expect(loaded.requests).toEqual(reqs);
});

test('append after close fails', async () => {
  const writer = await RunWriter.create(dir, makeRun());
  await writer.close();
  await expect(writer.append(makeRequest(makeRun(), 0))).rejects.toThrow('closed');
});

test('reader rejects a file that does not start with a run', async () => {
  const path = join(dir, 'bad.jsonl');
  await writeFile(path, JSON.stringify(makeRequest(makeRun(), 0)) + '\n');
  await expect(readRun(path)).rejects.toThrow('first record must be a run');
});
