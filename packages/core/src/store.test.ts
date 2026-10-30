import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newId } from './ids.ts';
import { createIdentity } from './identity.ts';
import type { ConsentEpoch, Flag, Hit, Request, Run, Step } from './records.ts';
import { RunWriter, readRun, runFilePath } from './store.ts';

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

test('reader reports the line of a non-object JSON record', async () => {
  const path = join(dir, 'scalar.jsonl');
  await writeFile(path, JSON.stringify(makeRun()) + '\nnull\n');
  await expect(readRun(path)).rejects.toThrow(':2: record must be a JSON object');
});

test('a step or consent epoch written again keeps the last record in the first position', async () => {
  const run = makeRun();
  const writer = await RunWriter.create(dir, run);
  const a = newId('step');
  const b = newId('step');
  const step = (id: Step['id'], endedAt: number | null): Step => ({
    type: 'step',
    id,
    runId: run.id,
    index: 0,
    label: 'load',
    startedAt: 1,
    endedAt,
  });
  await writer.append(step(a, null));
  await writer.append(step(b, 5));
  await writer.append(step(a, 9));
  const cep = newId('consentEpoch');
  const epoch = (endT: number | null): ConsentEpoch => ({
    type: 'consentEpoch',
    id: cep,
    runId: run.id,
    startT: 1,
    endT,
    source: 'banner',
    label: 'undecided',
    state: { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' },
  });
  await writer.append(epoch(null));
  await writer.append(epoch(7));
  await writer.close();
  const loaded = await readRun(writer.path);
  expect(loaded.steps.map((s) => [s.id, s.endedAt])).toEqual([
    [a, 9],
    [b, 5],
  ]);
  expect(loaded.consentEpochs.map((e) => e.endT)).toEqual([7]);
});

test('runFilePath rejects a run id that is not a run id', () => {
  expect(() => runFilePath(dir, '../x')).toThrow('invalid run id');
  expect(() => runFilePath(dir, newId('step'))).toThrow('invalid run id');
  expect(runFilePath(dir, newId('run'))).toMatch(/\.jsonl$/);
});

test('RunWriter.create rejects a run with a bad id', async () => {
  const run = { ...makeRun(), id: '../x' as Run['id'] };
  await expect(RunWriter.create(dir, run)).rejects.toThrow('invalid run id');
});

test('reader skips a cut-off last line but rejects a bad line in the middle', async () => {
  const run = makeRun();
  const req = makeRequest(run, 1);
  const writeComplete = async () => {
    const whole = join(dir, 'whole.jsonl');
    await writeFile(whole, [JSON.stringify(run), JSON.stringify(req)].join('\n') + '\n');
    return whole;
  };
  const cut = join(dir, 'cut.jsonl');
  await writeFile(cut, [JSON.stringify(run), JSON.stringify(req), '{"type":"requ'].join('\n'));
  const loaded = await readRun(cut);
  expect(loaded.requests).toEqual([req]);
  expect(loaded.truncatedAtLine).toBe(3);
  expect((await readRun(await writeComplete())).truncatedAtLine).toBeUndefined();

  const mid = join(dir, 'mid.jsonl');
  await writeFile(mid, [JSON.stringify(run), '{"type":"requ', JSON.stringify(req)].join('\n') + '\n');
  await expect(readRun(mid)).rejects.toThrow(':2: invalid JSON');

  const first = join(dir, 'first.jsonl');
  await writeFile(first, '{"type":"ru');
  await expect(readRun(first)).rejects.toThrow(':1: invalid JSON');
});

test('Run.identity accepts an Identity', () => {
  const run: Run = { ...makeRun(), identity: createIdentity(1) };
  expect(run.identity?.seed).toBe(1);
});

test('Hit.ids can carry hashed identity fields', () => {
  const ids: Hit['ids'] = { user_id: true, hashes: { em: { present: true, matchesIdentity: false } } };
  expect(JSON.parse(JSON.stringify(ids))).toEqual(ids);
});
