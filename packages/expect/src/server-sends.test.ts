import { createIdentity, newId, type ConsentState, type Hit, type HitVia, type Request, type Result, type Step } from '@tagreeve/core';
import { describe, expect, test } from 'vitest';
import { effectiveConsentAt, epochForHit, evaluate, judgeIndex, judgedAt, placeHitsInEpochs, type EvalEpoch } from './evaluate.ts';
import { parseScenario } from './scenario.ts';

const runId = newId('run');
const identity = createIdentity(1);
const unknown = { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;
const denied = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied', raw: {} } as const;
const granted = { analytics: 'granted', ads: 'granted', adUserData: 'granted', adPersonalization: 'granted', raw: {} } as const;

const DENIED_UNTIL = 1000;
const epochs: EvalEpoch[] = [
  { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: 0, endT: DENIED_UNTIL, source: 'test', label: 'denied', state: denied },
  { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: DENIED_UNTIL, endT: null, source: 'test', label: 'granted', state: granted },
];

interface Pair {
  hit: Hit;
  req: Request;
}

function pair(over: Partial<Hit>, server: boolean): Pair {
  const req: Request = {
    type: 'request', id: newId('request'), runId, stepId: null, t: over.t ?? 0, method: 'POST',
    url: server ? 'https://graph.facebook.com/v21.0/100000000000001/events' : 'https://www.facebook.com/tr/', resourceType: server ? 'fetch' : 'image',
    frameUrl: server ? null : 'http://localhost:3000/', initiator: server ? 'serverContainer' : null, headers: {}, postData: null, outcome: 'stubbed',
    ...(server && { captured: 'serverContainer' as const }),
  };
  const hit: Hit = {
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: req.id, t: 0, vendor: 'meta', event: 'Purchase',
    consent: unknown, ids: {}, page: null, transport: 'image', params: {}, fields: [], idFields: [], fieldsComplete: true, ...over,
  };
  return { hit, req };
}

const browser = (t: number, over: Partial<Hit> = {}) => pair({ t, ...over }, false);

function capi(t: number, via: HitVia | undefined, over: Partial<Hit> = {}): Pair {
  return pair({ t, vendor: 'meta-capi', transport: 'POST', fields: ['user_data.em[]'], idFields: ['user_data.em[]'], ...(via && { via }), ...over }, true);
}

const link = (to: Pair, confidence: HitVia['confidence']): HitVia => ({ hitId: to.hit.id, by: 'eventId', confidence });

function step(label: string, startedAt: number, endedAt: number): Step {
  return { type: 'step', id: newId('step'), runId, index: 0, kind: 'wait', label, startedAt, endedAt } as unknown as Step;
}

function run(yaml: string, pairs: Pair[], extra: unknown[] = []): Result[] {
  const records = [...pairs.flatMap((p) => [p.hit, p.req]), ...epochs, ...extra];
  return evaluate(records as never, parseScenario(`start: /\n${yaml}`), { identity });
}

const check = (results: Result[], name: string) => results.find((r) => r.expectation === `builtin: ${name}`)!;

describe('judgedAt', () => {
  test('a browser hit keeps its own time, a linked server hit takes its via hit, an unlinked one has none', () => {
    const via = browser(500);
    const linked = capi(1500, link(via, 'exact'));
    const unlinked = capi(1600, undefined);
    const index = judgeIndex([via.hit, linked.hit, unlinked.hit], [via.req, linked.req, unlinked.req]);
    expect(judgedAt(via.hit, index)).toBe(500);
    expect(judgedAt(linked.hit, index)).toBe(500);
    expect(judgedAt(unlinked.hit, index)).toBeUndefined();
  });

  test('a link to a hit that is not in the record counts as unlinked', () => {
    const lost = capi(1500, { hitId: newId('hit'), by: 'eventId', confidence: 'exact' });
    expect(judgedAt(lost.hit, judgeIndex([lost.hit], [lost.req]))).toBeUndefined();
  });

  test('placeHitsInEpochs and effectiveConsentAt use it', () => {
    const via = browser(500);
    const linked = capi(1500, link(via, 'exact'));
    const index = judgeIndex([via.hit, linked.hit], [via.req, linked.req]);
    expect(epochForHit(epochs, linked.hit.t)?.label).toBe('granted');
    expect(placeHitsInEpochs([linked.hit], epochs, 50, index).get(linked.hit)?.label).toBe('denied');
    expect(effectiveConsentAt(linked.hit, epochs, 50, index).adUserData).toBe('denied');
    const unlinked = capi(1500, undefined);
    const none: ConsentState = effectiveConsentAt(unlinked.hit, epochs, 50, judgeIndex([unlinked.hit], [unlinked.req]));
    expect(none.adUserData).toBe('unknown');
  });
});

describe('deniedIdentifiers on a server hit', () => {
  test('an exact link to a hit in the denied epoch fails, though the server hit was sent in the granted one', () => {
    const via = browser(500);
    const sent = capi(1500, link(via, 'exact'));
    expect(epochForHit(epochs, sent.hit.t)?.label).not.toBe(epochForHit(epochs, via.hit.t)?.label);
    const result = check(run('', [via, sent]), 'deniedIdentifiers');
    expect(result.pass).toBe(false);
    expect(result.severity).toBe('fail');
    expect(result.note).toBeUndefined();
    expect(result.evidence).toEqual([sent.hit.id]);
    expect(result.message).toContain('meta-capi');
  });

  test('a probable link fails at warn with the note serverSendProbableLink', () => {
    const via = browser(500);
    const sent = capi(1500, link(via, 'probable'));
    const result = check(run('', [via, sent]), 'deniedIdentifiers');
    expect(result).toMatchObject({ pass: false, severity: 'warn', note: 'serverSendProbableLink', evidence: [sent.hit.id] });
  });

  test('a probable link next to an exact one still fails', () => {
    const via = browser(500);
    const results = run('', [via, capi(1500, link(via, 'probable')), capi(1600, link(via, 'exact'))]);
    expect(check(results, 'deniedIdentifiers')).toMatchObject({ pass: false, severity: 'fail' });
  });

  test('a link to a hit in the granted epoch passes, though the server hit was sent in the denied one', () => {
    const via = browser(1200);
    const sent = capi(500, link(via, 'exact'));
    expect(epochForHit(epochs, sent.hit.t)?.label).toBe('denied');
    const result = check(run('', [via, sent]), 'deniedIdentifiers');
    expect(result.pass).toBe(true);
    expect(result.note).toBeUndefined();
  });

  test('a hit with no link cannot be judged: cannot evaluate at warn with the note serverSendUnlinked', () => {
    const sent = capi(500, undefined);
    const results = run('', [browser(100), sent]);
    for (const name of ['deniedIdentifiers', 'earlyIdentifiers']) {
      expect(check(results, name)).toMatchObject({ pass: false, severity: 'warn', note: 'serverSendUnlinked', evidence: [sent.hit.id] });
    }
  });

  test('an unlinked hit with no identifiers leaves the checks alone', () => {
    const quiet = capi(500, undefined, { fields: ['event_name'], idFields: [] });
    const results = run('', [quiet]);
    expect(check(results, 'deniedIdentifiers').pass).toBe(true);
    expect(check(results, 'earlyIdentifiers').pass).toBe(true);
  });
});

describe('rules on a server hit', () => {
  const rule = (yaml: string, pairs: Pair[], extra: unknown[] = []) => run(`expect:\n${yaml}`, pairs, extra)[0]!;

  test('in: epoch(denied) uses the via hit time, not the server hit time', () => {
    const via = browser(500);
    const sent = capi(1500, link(via, 'exact'));
    const text = '  mustNot:\n    - { vendor: meta-capi, in: epoch(denied) }';
    expect(rule(text, [via, sent])).toMatchObject({ pass: false, evidence: [sent.hit.id] });
    expect(rule('  must:\n    - { vendor: meta-capi, in: epoch(granted) }', [via, sent]).pass).toBe(false);
  });

  test('after: uses the via hit time', () => {
    const via = browser(500);
    const sent = capi(1500, link(via, 'exact'));
    const go = step('go', 0, 800);
    expect(sent.hit.t).toBeGreaterThanOrEqual(go.endedAt!);
    const text = 'steps:\n  - { wait: 1s, label: go }\nexpect:\n  mustNot:\n    - { vendor: meta-capi, after: go }';
    expect(run(text, [via, sent], [go])[0]!.pass).toBe(true);
  });

  test('a failing mustNot on a probable link warns, a passing must on one carries the note', () => {
    const via = browser(500);
    const sent = capi(1500, link(via, 'probable'));
    expect(rule('  mustNot:\n    - { vendor: meta-capi, in: epoch(denied) }', [via, sent])).toMatchObject({ pass: false, severity: 'warn', note: 'serverSendProbableLink' });
    expect(rule('  must:\n    - { vendor: meta-capi, in: epoch(denied) }', [via, sent])).toMatchObject({ pass: true, note: 'serverSendProbableLink' });
  });

  test('a consent-scoped rule that meets an unlinked hit cannot be judged', () => {
    const sent = capi(1500, undefined);
    expect(rule('  mustNot:\n    - { vendor: meta-capi, in: epoch(denied) }', [sent])).toMatchObject({ pass: false, severity: 'warn', note: 'serverSendUnlinked', evidence: [sent.hit.id] });
    expect(rule('  must:\n    - { vendor: meta-capi, consent.adUserData: granted }', [sent])).toMatchObject({ pass: false, severity: 'warn', note: 'serverSendUnlinked' });
  });

  test('a rule without a consent scope counts an unlinked hit as it does any other', () => {
    const sent = capi(1500, undefined);
    expect(rule('  must:\n    - { vendor: meta-capi }', [sent])).toMatchObject({ pass: true });
    const found = rule('  mustNot:\n    - { vendor: meta-capi }', [sent]);
    expect(found.pass).toBe(false);
    expect(found.severity).toBeUndefined();
  });

  test('before: consent never takes an unlinked hit as early', () => {
    const sent = capi(1500, undefined);
    const results = run('expect:\n  mustNot:\n    - { vendor: meta-capi, before: consent }', [sent]);
    expect(results[0]).toMatchObject({ note: 'serverSendUnlinked' });
  });
});
