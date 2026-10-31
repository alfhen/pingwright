import { newId, type ConsentEpoch, type ConsentState, type Hit, type Request, type Result, type RunRecords } from '@pingwright/core';
import { decodeRequest } from '@pingwright/decoders';
import { describe, expect, test } from 'vitest';
import { buildReportModel, type ReportModel } from './model.ts';

const runId = newId('run');
const state = (over: Partial<ConsentState> = {}): ConsentState => ({ analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', ...over });
const DENIED = state({ analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' });
const GRANTED = state({ analytics: 'granted', ads: 'granted', adUserData: 'granted', adPersonalization: 'granted' });

function epoch(label: ConsentEpoch['label'], startT: number, st: ConsentState, endT: number | null = null): ConsentEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', label, state: st };
}

function hit(vendor: string, t: number, over: Partial<Hit> = {}, consent: Partial<ConsentState> = {}): Hit {
  return {
    type: 'hit',
    id: newId('hit'),
    runId,
    stepId: null,
    requestId: newId('request'),
    t,
    vendor,
    event: 'page_view',
    consent: { ...state(consent), raw: {} },
    ids: {},
    page: null,
    transport: 'image',
    params: {},
    fields: [],
    fieldsComplete: true,
    idFields: [],
    ...over,
  };
}

function result(expectation: string, pass: boolean, over: Partial<Result> = {}): Result {
  return { type: 'result', id: newId('result'), runId, expectation, pass, evidence: [], ...over };
}

function records(over: Partial<RunRecords> & { version?: number; graceWindowMs?: number } = {}): RunRecords {
  const { version = 2, graceWindowMs, ...rest } = over;
  return {
    run: {
      type: 'run',
      id: runId,
      recordSchemaVersion: version,
      scenario: 'scenario.yml',
      site: 'http://127.0.0.1:4000/identifiers?state=denied',
      startedAt: 1_800_000_000_000,
      pingwrightVersion: '0.3.0',
      browser: { name: 'chromium', version: '156' },
      networkMode: 'stub',
      gtmOverride: null,
      containerVersions: {},
      identity: null,
      ...(graceWindowMs !== undefined && { graceWindowMs }),
    },
    steps: [],
    requests: [],
    responses: [],
    hits: [],
    dataLayerEvents: [],
    tagReports: [],
    consentEpochs: [epoch('undecided', 0, state(), 1000), epoch('denied', 1000, DENIED, 2000), epoch('withdrawn', 2000, DENIED)],
    checkpoints: [],
    results: [],
    flags: [],
    collectorReports: [],
    invalidReports: [],
    ...rest,
  };
}

function marksOf(model: ReportModel, vendor: string): string[] {
  return model.rows.find((r) => r.vendor === vendor)!.segments.map((s) => s.mark);
}

test('columns follow the consent epochs, one row per vendor, with hit counts', () => {
  const model = buildReportModel(
    records({ hits: [hit('meta', 500), hit('meta', 600), hit('ga4', 1500, {}, { analytics: 'granted' })] }),
  );
  expect(model.columns.map((c) => c.label)).toEqual(['undecided', 'denied', 'withdrawn']);
  expect(model.rows.map((r) => [r.vendor, r.hits])).toEqual([['ga4', 1], ['meta', 2]]);
  expect(model.rows[1]!.segments.map((s) => s.hits)).toEqual([2, 0, 0]);
  expect(marksOf(model, 'meta')).toEqual(['full', 'nothing', 'nothing']);
});

test('a record with no epochs has one undecided column', () => {
  const model = buildReportModel(records({ consentEpochs: [], hits: [hit('meta', 1)] }));
  expect(model.columns.map((c) => c.label)).toEqual(['undecided']);
  expect(marksOf(model, 'meta')).toEqual(['full']);
});

test('a denied hit with no identifiers is a ping, a granted hit is full, no hit is nothing', () => {
  const model = buildReportModel(records({ hits: [hit('meta', 1500), hit('ga4', 1500, {}, { analytics: 'granted', ads: 'granted' })] }));
  expect(marksOf(model, 'meta')).toEqual(['nothing', 'ping', 'nothing']);
  expect(model.rows[1]!.segments[1]!.label).toBe('hit sent while denied, no identifiers recorded');
  expect(marksOf(model, 'ga4')[1]).toBe('full');
});

test('a segment with one leaking hit and one granted hit shows leak', () => {
  const model = buildReportModel(
    records({
      consentEpochs: [epoch('denied', 0, DENIED)],
      hits: [hit('ga4', 100, { idFields: ['uid'] }, { analytics: 'denied' }), hit('ga4', 200, {}, { analytics: 'granted' })],
    }),
  );
  expect(marksOf(model, 'ga4')).toEqual(['leak']);
});

test('identifier names flag a hit by the signal of their class', () => {
  const model = buildReportModel(
    records({
      hits: [
        hit('meta', 1500, { idFields: ['ud[em]'] }),
        hit('ga4', 1500, { idFields: ['user_id'] }, { analytics: 'granted', ads: 'denied', adUserData: 'denied' }),
      ],
    }),
  );
  expect(marksOf(model, 'meta')[1]).toBe('leak');
  const ga4 = model.rows.find((r) => r.vendor === 'ga4')!.segments[1]!;
  expect(ga4.mark).toBe('mixed');
  expect(ga4.label).toBe('some signals denied');
});

test('an sgtm hit with a granted gcs in a denied epoch is a leak', () => {
  const model = buildReportModel(records({ hits: [hit('sgtm', 1500, { idFields: ['external_id'] }, { analytics: 'granted', ads: 'granted' })] }));
  expect(marksOf(model, 'sgtm')[1]).toBe('leak');
});

test('an unknown Meta hit in a denied epoch takes the epoch state', () => {
  const model = buildReportModel(records({ hits: [hit('meta', 1500, { idFields: ['external_id'] })] }));
  expect(marksOf(model, 'meta')[1]).toBe('leak');
});

test('a denied hit with a cut body is unchecked, never ping', () => {
  const model = buildReportModel(records({ hits: [hit('sgtm', 1500, { fieldsComplete: false })] }));
  const seg = model.rows[0]!.segments[1]!;
  expect(seg.mark).toBe('unchecked');
  expect(seg.label).toBe('body not fully recorded');
});

test('a denied hit on a version 1 record is unchecked and fields say not recorded', () => {
  const old = hit('ga4', 1500, { idFields: undefined, fields: undefined, fieldsComplete: undefined });
  const model = buildReportModel(records({ version: 1, hits: [old] }));
  expect(marksOf(model, 'ga4')[1]).toBe('unchecked');
  expect(model.fields).toBeUndefined();
  expect(model.header.schemaVersion).toBe(1);
});

test('unchecked beats mixed, full and ping', () => {
  const model = buildReportModel(
    records({
      consentEpochs: [epoch('denied', 0, DENIED)],
      hits: [
        hit('ga4', 100, { fieldsComplete: false }),
        hit('ga4', 110),
        hit('ga4', 120, {}, { analytics: 'granted', ads: 'denied', adUserData: 'denied' }),
        hit('ga4', 130, {}, { analytics: 'granted', ads: 'granted', adUserData: 'granted' }),
      ],
    }),
  );
  expect(marksOf(model, 'ga4')).toEqual(['unchecked']);
});

test('a segment with granted and ping hits is mixed, and mixed beats full', () => {
  const both = buildReportModel(
    records({ consentEpochs: [epoch('denied', 0, DENIED)], hits: [hit('ga4', 100, {}, { analytics: 'granted', ads: 'granted' }), hit('ga4', 110, {}, { analytics: 'denied', ads: 'denied' })] }),
  );
  expect(marksOf(both, 'ga4')).toEqual(['mixed']);
  expect(both.rows[0]!.segments[0]!.label).toBe('granted and denied hits');
  const withMixedHit = buildReportModel(
    records({ consentEpochs: [epoch('denied', 0, DENIED)], hits: [hit('ga4', 100, {}, { analytics: 'granted', ads: 'granted' }), hit('ga4', 110, {}, { analytics: 'granted', ads: 'denied' })] }),
  );
  expect(marksOf(withMixedHit, 'ga4')).toEqual(['mixed']);
  expect(withMixedHit.rows[0]!.segments[0]!.label).toBe('some signals denied');
});

test('a hit with an unknown state before an answer is full with the label before an answer', () => {
  const model = buildReportModel(records({ hits: [hit('meta', 500)] }));
  const seg = model.rows[0]!.segments[0]!;
  expect(seg.mark).toBe('full');
  expect(seg.label).toBe('before an answer');
});

describe('consent-scoped mustNot evidence', () => {
  const failed = (expectation: string, h: Hit) => result(expectation, false, { evidence: [h.id] });
  const granted = () => hit('ga4', 100, {}, { analytics: 'granted', ads: 'granted' });

  test('a failed mustNot with no consent scope leaves a granted hit full', () => {
    const h = granted();
    const model = buildReportModel(records({ consentEpochs: [epoch('granted', 0, GRANTED)], hits: [h], results: [failed('mustNot: {"vendor":"ga4"}', h)] }));
    expect(marksOf(model, 'ga4')).toEqual(['full']);
  });

  test.each([
    ['in epoch(denied)', '{"vendor":"ga4","in":"epoch(denied)"}'],
    ['in epoch(label=denied)', '{"vendor":"ga4","in":"epoch(label=denied)"}'],
    ['in epoch(analytics=denied)', '{"vendor":"ga4","in":"epoch(analytics=denied)"}'],
    ['in epoch(label=withdrawn)', '{"vendor":"ga4","in":"epoch(label=withdrawn)"}'],
    ['consent.ad_storage: denied', '{"vendor":"ga4","consent.ads":"denied"}'],
    ['a nested consent group', '{"vendor":"ga4","consent":{"ads":"denied"}}'],
    ['before consent', '{"vendor":"ga4","before":"consent"}'],
  ])('a failed mustNot with %s marks its hit as leak', (_name, entry) => {
    const h = granted();
    const model = buildReportModel(records({ consentEpochs: [epoch('granted', 0, GRANTED)], hits: [h], results: [failed(`mustNot: ${entry}`, h)] }));
    expect(marksOf(model, 'ga4')).toEqual(['leak']);
  });

  test('a hit named by a rule has its own label, not the identifier one', () => {
    const h = granted();
    const model = buildReportModel(records({ consentEpochs: [epoch('granted', 0, GRANTED)], hits: [h], results: [failed('mustNot: {"vendor":"ga4","in":"epoch(denied)"}', h)] }));
    expect(model.rows[0]!.segments[0]!.label).toBe('named by a failed consent-scoped rule');
  });

  test('a passing consent-scoped mustNot and a cannot-evaluate one mark nothing', () => {
    const h = granted();
    const entry = 'mustNot: {"vendor":"ga4","in":"epoch(denied)"}';
    const model = buildReportModel(
      records({
        consentEpochs: [epoch('granted', 0, GRANTED)],
        hits: [h],
        results: [result(entry, true, { evidence: [h.id] }), result(entry, false, { evidence: [h.id], note: 'cannotEvaluateBody' })],
      }),
    );
    expect(marksOf(model, 'ga4')).toEqual(['full']);
  });
});

test('a custom graceWindow puts a boundary hit in the same epoch as the check', () => {
  const boundary = hit('meta', 900);
  const epochs = [epoch('undecided', 0, state(), 1000), epoch('granted', 1000, GRANTED)];
  const fallback = buildReportModel(records({ consentEpochs: epochs, hits: [boundary] }));
  expect(fallback.rows[0]!.segments.map((s) => s.hits)).toEqual([1, 0]);
  const wide = buildReportModel(records({ consentEpochs: epochs, graceWindowMs: 100, hits: [boundary] }));
  expect(wide.rows[0]!.segments.map((s) => s.hits)).toEqual([0, 1]);
});

test('a real decoded GA4 G100 hit with cid is a ping', () => {
  const request: Request = {
    type: 'request',
    id: newId('request'),
    runId,
    stepId: null,
    t: 1500,
    method: 'GET',
    url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1111111111.2222222222&en=page_view&gcs=G100',
    resourceType: 'image',
    frameUrl: null,
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
  };
  const hits = decodeRequest(request).map((h) => ({ ...h, t: 1500 }));
  const model = buildReportModel(records({ hits }));
  expect(marksOf(model, 'ga4')[1]).toBe('ping');
});

test('expectations: statuses, builtin names, notes and a value-free form', () => {
  const entry = JSON.stringify({ vendor: 'ga4', params: { em: 'pw-fixture@example.com' }, ids: { 'hashes.em': 'abc123' }, page: { matches: 'secret' }, 'body.has': ['user_data'], 'consent.ads': 'denied', in: 'epoch(denied)' });
  const model = buildReportModel(
    records({
      results: [
        result(`mustNot: ${entry}`, false, { evidence: ['hit_1', 'hit_2', 'hit_3', 'hit_4', 'hit_5', 'hit_6', 'hit_7'], message: 'secret message' }),
        result('builtin: deniedIdentifiers', false, { severity: 'warn' }),
        result('must: {"cookie":"_pwid"}', true, { note: 'stubNoCookies' }),
        result('must: {"body.only":["a"]}', false, { note: 'cannotEvaluateBody' }),
        result('builtin: unknownDestination', true),
      ],
    }),
  );
  const [leak, warn, stub, cannot, builtin] = model.expectations;
  expect(leak!.status).toBe('FAIL');
  expect(leak!.text).toBe('mustNot: vendor: ga4, params.em, ids.hashes.em, page.matches, body.has: user_data, consent.ads: denied, in: epoch(denied)');
  expect(leak!.evidence).toHaveLength(5);
  expect(leak!.evidenceCount).toBe(7);
  expect(warn).toMatchObject({ status: 'WARN', kind: 'builtin', text: 'builtin: deniedIdentifiers', severity: 'warn' });
  expect(stub!.status).toBe('PASS');
  expect(stub!.note).toContain('stubbed endpoints set no cookies');
  expect(cannot!.status).toBe('CANNOT EVALUATE');
  expect(cannot!.note).toBe('cannot evaluate: body not fully recorded');
  expect(builtin!.status).toBe('PASS');
  expect(JSON.stringify(model)).not.toContain('secret');
  expect(JSON.stringify(model)).not.toContain('pw-fixture');
});

test('an unreadable expectation shows as a bare rule', () => {
  const model = buildReportModel(records({ results: [result('mustNot: {not json pw-fixture@example.com', true)] }));
  expect(model.expectations[0]!.text).toBe('rule');
});

test('flags count by kind and show hosts only', () => {
  const request: Request = {
    type: 'request',
    id: newId('request'),
    runId,
    stepId: null,
    t: 1,
    method: 'GET',
    url: 'https://tracker.example.com/path?secret=1',
    resourceType: 'image',
    frameUrl: null,
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
  };
  const flag = { type: 'flag' as const, id: newId('flag'), runId, kind: 'unknownDestination', recordIds: [request.id], detail: 'GET https://tracker.example.com/path?secret=1' };
  const model = buildReportModel(records({ requests: [request], flags: [flag, { ...flag, id: newId('flag') }] }));
  expect(model.flags).toEqual([{ kind: 'unknownDestination', count: 2, hosts: ['tracker.example.com'] }]);
});

test('fields list names seen while a signal was denied, and guard value-like names', () => {
  const model = buildReportModel(
    records({
      hits: [
        hit('sgtm', 1500, { fields: ['event_name', 'user_data.email_address', `user_data.${'a'.repeat(64)}`] }),
        hit('sgtm', 500, { fields: ['before_answer_only'] }),
      ],
    }),
  );
  expect(model.fields).toEqual([{ vendor: 'sgtm', names: ['event_name', 'user_data.(other)', 'user_data.email_address'] }]);
});

test('the header keeps the host only', () => {
  const model = buildReportModel(records());
  expect(model.header.host).toBe('127.0.0.1:4000');
  expect(model.header.networkMode).toBe('stub');
});

describe('deniedIdentifiers evidence', () => {
  const denied = () => hit('sgtm', 1500);
  const failedCheck = (h: Hit, severity: 'fail' | 'warn') => result('builtin: deniedIdentifiers', false, { evidence: [h.id], severity });

  test('every evidence hit marks its own segment as a leak', () => {
    const early = hit('sgtm', 500);
    const late = denied();
    const check = result('builtin: deniedIdentifiers', false, { evidence: [early.id, late.id], severity: 'warn' });
    const model = buildReportModel(records({ hits: [early, late], results: [check] }));
    expect(marksOf(model, 'sgtm')).toEqual(['leak', 'leak', 'nothing']);
  });

  test.each(['fail', 'warn'] as const)('a denied hit with no idFields named in a failed check at %s is a leak, not a ping', (severity) => {
    const h = denied();
    expect(marksOf(buildReportModel(records({ hits: [h] })), 'sgtm')).toEqual(['nothing', 'ping', 'nothing']);
    const model = buildReportModel(records({ hits: [h], results: [failedCheck(h, severity)] }));
    expect(marksOf(model, 'sgtm')).toEqual(['nothing', 'leak', 'nothing']);
    expect(model.rows[0]!.segments[1]!.label).toBe('identifiers sent while denied');
  });

  test('a passing check and a cannot-evaluate check mark nothing', () => {
    const h = denied();
    const model = buildReportModel(
      records({ hits: [h], results: [result('builtin: deniedIdentifiers', true, { evidence: [h.id] }), result('builtin: deniedIdentifiers', false, { evidence: [h.id], note: 'cannotEvaluateBody' })] }),
    );
    expect(marksOf(model, 'sgtm')).toEqual(['nothing', 'ping', 'nothing']);
  });
});
