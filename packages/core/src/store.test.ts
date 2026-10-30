import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { newId } from './ids.ts';
import { createIdentity } from './identity.ts';
import { RECORD_SCHEMA_VERSION, type ConsentEpoch, type Flag, type Hit, type Request, type Run, type Step } from './records.ts';
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
  expect(loaded.run).toEqual({ ...run, recordSchemaVersion: RECORD_SCHEMA_VERSION });
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

test('reader rejects a run record with no required fields', async () => {
  const path = join(dir, 'empty-run.jsonl');
  await writeFile(path, '{"type":"run"}\n');
  await expect(readRun(path)).rejects.toThrow(`${path}:1: run record is missing id, scenario, site, startedAt`);
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

async function writeLines(name: string, run: Record<string, unknown>): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, JSON.stringify(run) + '\n');
  return path;
}

test('RunWriter stamps the current record schema version', async () => {
  const run = makeRun();
  const writer = await RunWriter.create(dir, run);
  await writer.close();
  const first = JSON.parse((await readFile(writer.path, 'utf8')).split('\n')[0]!) as Run;
  expect(first.recordSchemaVersion).toBe(RECORD_SCHEMA_VERSION);
  const warnings: string[] = [];
  const read = await readRun(writer.path, { onWarning: (m) => warnings.push(m) });
  expect(read.run.recordSchemaVersion).toBe(1);
  expect(warnings).toEqual([]);
});

test('a run with no version reads as version 0 without a warning', async () => {
  const warnings: string[] = [];
  const path = await writeLines('old.jsonl', makeRun() as unknown as Record<string, unknown>);
  const read = await readRun(path, { onWarning: (m) => warnings.push(m) });
  expect(read.run.recordSchemaVersion).toBe(0);
  expect(warnings).toEqual([]);
});

test('a run with a newer version reads with a warning', async () => {
  const path = await writeLines('new.jsonl', { ...makeRun(), recordSchemaVersion: RECORD_SCHEMA_VERSION + 1 });
  const warnings: string[] = [];
  const read = await readRun(path, { onWarning: (m) => warnings.push(m) });
  expect(read.run.recordSchemaVersion).toBe(RECORD_SCHEMA_VERSION + 1);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('newer');
});

test('a version that is not a non-negative integer is rejected', async () => {
  const path = await writeLines('bad.jsonl', { ...makeRun(), recordSchemaVersion: '1' });
  await expect(readRun(path)).rejects.toThrow('recordSchemaVersion');
});
