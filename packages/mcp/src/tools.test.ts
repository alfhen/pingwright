import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { PingwrightRecord } from '@pingwright/core';
import { diffRunsTool, getHits, getSuite, getSummary, listRuns, parseRunId, parseSuiteId, ToolError } from './tools.ts';

const EMAIL = 'pw-fixture@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');
const COOKIE = 'pwcookievalue123456';

const RUN_A = 'run_00000000000000000000000001';
const RUN_B = 'run_00000000000000000000000002';
const RUN_C = 'run_00000000000000000000000003';
const SUITE = 'suite_0000000000000000000000000A';

function records(runId: string, options: { extraHit?: boolean; failing?: boolean } = {}): PingwrightRecord[] {
  const page = `https://shop.example.com/checkout?em=${EMAIL}&h=${HASH}`;
  const hit = (n: number, event: string, t: number, analytics: 'granted' | 'denied') => ({
    type: 'hit',
    id: `hit_${runId.slice(4, 26)}${n}`,
    runId,
    stepId: 'stp_1',
    requestId: `req_${n}`,
    t,
    vendor: 'ga4',
    event,
    consent: { analytics, ads: analytics, adUserData: analytics, adPersonalization: analytics, raw: { gcs: 'G111' } },
    ids: { client_id: true, user_id: false, hashes: { em: { present: true, matchesIdentity: true } } },
    page,
    transport: 'beacon',
    params: { em: EMAIL, cookie: COOKIE },
    fields: ['em', 'en'],
  });
  const out: unknown[] = [
    { type: 'run', id: runId, recordSchemaVersion: 2, scenario: 'checkout.yml', site: `https://shop.example.com/?em=${EMAIL}`, startedAt: 1000, variant: 'desktop' },
    { type: 'step', id: 'stp_1', runId, index: 0, label: 'accept banner', startedAt: 1, endedAt: 2 },
    { type: 'consentEpoch', id: 'cep_1', runId, startT: 0, endT: 500, source: 'banner', label: 'undecided', state: {} },
    { type: 'consentEpoch', id: 'cep_2', runId, startT: 500, endT: null, source: 'banner', label: 'granted', state: {} },
    {
      type: 'request',
      id: 'req_1',
      runId,
      url: `https://www.google-analytics.com/g/collect?em=${EMAIL}`,
      headers: { cookie: `a=${COOKIE}` },
      postData: HASH,
    },
    hit(1, 'page_view', 100, 'denied'),
    hit(2, 'purchase', 900, 'granted'),
    { type: 'flag', id: 'flg_1', runId, kind: 'stubBypass', recordIds: [], detail: `request reached https://x.example.com/p?em=${EMAIL}` },
    { type: 'flag', id: 'flg_2', runId, kind: 'sandboxPageUrl', recordIds: [], detail: `meta received https://shop.example.com/web-pixels@1/sandbox/?em=${HASH} as the page` },
    { type: 'flag', id: 'flg_3', runId, kind: 'unknownDestination', recordIds: [], detail: `blocked https://unknown.pingwright.invalid/x?em=${EMAIL}` },
    {
      type: 'result',
      id: 'rsl_1',
      runId,
      expectation: 'hit(ga4, purchase)',
      pass: !options.failing,
      evidence: [`hit_${EMAIL}`],
      message: `got ${EMAIL} ${COOKIE}`,
      path: '/Users/someone/secret.jsonl',
    },
    { type: 'result', id: 'rsl_2', runId, expectation: 'builtin: unknownDestination', pass: false, severity: 'warn', evidence: [], message: HASH },
  ];
  if (options.extraHit) out.push(hit(3, 'view_item', 950, 'granted'));
  return out as PingwrightRecord[];
}

async function writeRun(dir: string, runId: string, options?: Parameters<typeof records>[1]) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${runId}.jsonl`), records(runId, options).map((r) => JSON.stringify(r) + '\n').join(''));
}

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-mcp-'));
  await writeRun(dir, RUN_A);
  await writeRun(dir, RUN_B, { extraHit: true, failing: true });
  const suiteDir = join(dir, SUITE);
  await writeRun(suiteDir, RUN_C);
  await writeFile(
    join(suiteDir, 'suite.json'),
    JSON.stringify({
      suiteSchemaVersion: 1,
      id: SUITE,
      startedAt: 5,
      site: 'https://shop.example.com',
      variants: ['desktop'],
      cells: [{ scenario: 'checkout.yml', variant: 'desktop', labels: {}, status: 'pass', exitCode: 0, record: `${RUN_C}.jsonl` }],
      diffs: [],
      exitCode: 0,
    }),
  );
  await writeFile(join(dir, 'run_notaulid.jsonl'), 'not json');
  await symlink(join(dir, `${RUN_A}.jsonl`), join(dir, 'run_0000000000000000000000000S.jsonl'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function noValues(result: unknown) {
  const text = JSON.stringify(result);
  for (const value of [EMAIL, encodeURIComponent(EMAIL), HASH, COOKIE, 'example.com/checkout', '/Users/someone', 'unknown.pingwright.invalid/x']) {
    expect(text).not.toContain(value);
  }
}

describe('list_runs', () => {
  test('lists runs from the folder and suite folders, newest first', async () => {
    const result = await listRuns(dir);
    expect(result.schemaVersion).toBe(1);
    expect(result.runs.map((r) => r.runId)).toEqual([RUN_C, RUN_B, RUN_A]);
    expect(result.runs[2]).toEqual({ runId: RUN_A, scenario: 'checkout.yml', siteHost: 'shop.example.com', startedAt: 1000, variant: 'desktop', ok: true });
    expect(result.runs[1]!.ok).toBe(false);
    noValues(result);
  });

  test('limit cuts the list', async () => {
    expect((await listRuns(dir, { limit: 1 })).runs).toHaveLength(1);
  });

  test('an empty or missing folder gives an empty list', async () => {
    expect((await listRuns(join(dir, 'missing'))).runs).toEqual([]);
  });
});

describe('get_summary', () => {
  test('returns counts, epochs, flag kinds and results without messages, evidence or details', async () => {
    const result = await getSummary(dir, { runId: RUN_A });
    expect(result).toMatchObject({
      schemaVersion: 1,
      runId: RUN_A,
      pass: false,
      ok: true,
      hits: { ga4: { page_view: 1, purchase: 1 } },
      flags: { stubBypass: 1, sandboxPageUrl: 1, unknownDestination: 1 },
      results: [
        { expectation: 'hit(ga4, purchase)', pass: true, severity: 'fail' },
        { expectation: 'builtin: unknownDestination', pass: false, severity: 'warn' },
      ],
    });
    expect(result.results[0]).not.toHaveProperty('message');
    expect(result.results[0]).not.toHaveProperty('evidence');
    noValues(result);
  });

  test('a failing run is not ok', async () => {
    expect((await getSummary(dir, { runId: RUN_B })).ok).toBe(false);
  });
});

describe('get_hits', () => {
  test('returns hits with names and presence only', async () => {
    const result = await getHits(dir, { runId: RUN_A });
    expect(result.total).toBe(2);
    expect(result.hits[0]).toEqual({
      hitId: expect.stringMatching(/^hit_/),
      vendor: 'ga4',
      event: 'page_view',
      epoch: 'undecided',
      consent: { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' },
      ids: { client_id: true, user_id: false, 'hashes.em': true },
      fields: ['em', 'en'],
      step: 'accept banner',
    });
    noValues(result);
  });

  test('filters by vendor, event and epoch', async () => {
    expect((await getHits(dir, { runId: RUN_A, event: 'purchase' })).hits.map((h) => h.event)).toEqual(['purchase']);
    expect((await getHits(dir, { runId: RUN_A, epoch: 'undecided' })).hits.map((h) => h.event)).toEqual(['page_view']);
    expect((await getHits(dir, { runId: RUN_A, vendor: 'meta' })).total).toBe(0);
  });

  test('limit marks the result truncated', async () => {
    const result = await getHits(dir, { runId: RUN_B, limit: 1 });
    expect(result).toMatchObject({ total: 3, truncated: true });
    expect(result.hits).toHaveLength(1);
  });
});

describe('diff_runs', () => {
  test('reports an added hit and no page values', async () => {
    const result = await diffRunsTool(dir, { a: RUN_A, b: RUN_B });
    expect(result.added.map((h) => h.key.event)).toEqual(['view_item']);
    expect(result.added[0]).not.toHaveProperty('page');
    expect(result.added[0]!.key).not.toHaveProperty('page');
    noValues(result);
  });
});

describe('get_suite', () => {
  test('returns the manifest with run IDs instead of file names', async () => {
    const result = await getSuite(dir, { suiteId: SUITE });
    expect(result).toMatchObject({ schemaVersion: 1, suiteId: SUITE, site: 'https://shop.example.com', cells: [{ scenario: 'checkout.yml', runId: RUN_C }] });
    expect(result.cells[0]).not.toHaveProperty('record');
  });

  test('an unknown suite is an error', async () => {
    await expect(getSuite(dir, { suiteId: 'suite_0000000000000000000000000B' })).rejects.toBeInstanceOf(ToolError);
  });
});

describe('ID refusal', () => {
  test.each(['../x', '/etc/passwd', `${dir}/${RUN_A}`, 'run_123', `${RUN_A}.jsonl`, `${RUN_A}/../${RUN_B}`, 'run_0000000000000000000000000I', ''])(
    'refuses run ID %s',
    async (id) => {
      expect(() => parseRunId(id)).toThrow(ToolError);
      await expect(getSummary(dir, { runId: id })).rejects.toBeInstanceOf(ToolError);
      await expect(getHits(dir, { runId: id })).rejects.toBeInstanceOf(ToolError);
      await expect(diffRunsTool(dir, { a: RUN_A, b: id })).rejects.toBeInstanceOf(ToolError);
    },
  );

  test.each(['../x', '/tmp', SUITE.replace('suite_', 'run_'), 'suite_short', `${SUITE}/suite.json`])('refuses suite ID %s', async (id) => {
    expect(() => parseSuiteId(id)).toThrow(ToolError);
    await expect(getSuite(dir, { suiteId: id })).rejects.toBeInstanceOf(ToolError);
  });

  test('a well-formed ID with no run is an error', async () => {
    await expect(getSummary(dir, { runId: 'run_0000000000000000000000000B' })).rejects.toThrow(/No run/);
  });

  test('a symbolic link is not served as a run', async () => {
    await expect(getSummary(dir, { runId: 'run_0000000000000000000000000S' })).rejects.toThrow(/No run/);
  });
});
