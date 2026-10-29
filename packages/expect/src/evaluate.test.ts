import {
  createIdentity,
  hashEmail,
  hashPhone,
  newId,
  type Flag,
  type Hit,
  type Request,
  type Step,
} from '@pingwright/core';
import { expect, test } from 'vitest';
import { evaluate, type EvalEpoch } from './evaluate.ts';
import { parseScenario } from './scenario.ts';
import { README_SCENARIO } from './readme-scenario.ts';

const runId = newId('run');
const PAGE = 'http://localhost:3000/products/fake-tee';
const SANDBOX = 'http://localhost:3000/web-pixels@0.0.0-fixture/sandbox/modern/';
const identity = createIdentity(1);

const allUnknown = { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;
const denied = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied', raw: { gcs: 'G100' } } as const;
const granted = { analytics: 'granted', ads: 'granted', adUserData: 'granted', adPersonalization: 'granted', raw: { gcs: 'G111' } } as const;

function request(over: Partial<Request> = {}): Request {
  return {
    type: 'request', id: newId('request'), runId, stepId: null, t: 0, method: 'GET',
    url: 'http://127.0.0.1:9000/collect', resourceType: 'image', frameUrl: PAGE, initiator: null,
    headers: {}, postData: null, outcome: 'stubbed', ...over,
  };
}

function hit(over: Partial<Hit> = {}, req: Partial<Request> = {}): { hit: Hit; req: Request } {
  const r = request({ t: over.t ?? 0, ...req });
  return {
    req: r,
    hit: {
      type: 'hit', id: newId('hit'), runId, stepId: null, requestId: r.id, t: 0, vendor: 'ga4', event: 'page_view',
      consent: allUnknown, ids: {}, page: PAGE, transport: 'image', params: {}, ...over,
    },
  };
}

function epoch(startT: number, endT: number | null, state: EvalEpoch['state']): EvalEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', state };
}

const UNDECIDED_THEN_ACCEPT = [epoch(0, 1000, 'undecided'), epoch(1000, null, granted)];

function run(yaml: string, records: unknown[]) {
  const flat = records.flatMap((r) => (r && typeof r === 'object' && 'hit' in r ? [(r as { hit: Hit }).hit, (r as unknown as { req: Request }).req] : [r]));
  return evaluate(flat as never, parseScenario(yaml));
}

function rule(yaml: string, records: unknown[]) {
  return run(`start: /\n${yaml}`, records)[0]!;
}

test('README example: user_id present while analytics denied fails, with the hit as evidence', () => {
  const bad = hit({ consent: denied, ids: { user_id: true, client_id: true }, t: 100 });
  const ok1 = hit({ consent: denied, ids: { client_id: true }, t: 200 });
  const ok2 = hit({ consent: denied, ids: { client_id: true }, t: 300 });
  const results = run(README_SCENARIO, [bad, ok1, ok2, epoch(0, null, 'undecided')]);
  const [noPre, noUid, pageViews] = results;
  expect(noPre!.pass).toBe(true);
  expect(noUid!.pass).toBe(false);
  expect(noUid!.evidence).toEqual([bad.hit.id]);
  expect(noUid!.message).toContain('Expected no matching hits');
  expect(noUid!.message).toContain('found 1 matching hit');
  expect(pageViews!.pass).toBe(true);
  expect(pageViews!.evidence).toHaveLength(3);
});

test('README example passes when user_id is absent and a vendor fires only after consent', () => {
  const afterAccept = hit({ vendor: 'meta', t: 2000 });
  const results = run(README_SCENARIO, [
    afterAccept, hit({ consent: denied, t: 10 }), hit({ consent: denied, t: 20 }), ...UNDECIDED_THEN_ACCEPT,
  ]);
  expect(results.every((r) => r.pass)).toBe(true);
});

test('README example fails must when only one page_view is seen', () => {
  const results = run(README_SCENARIO, [hit({ consent: denied }), epoch(0, null, 'undecided')]);
  const must = results[2]!;
  expect(must.pass).toBe(false);
  expect(must.message).toContain('Expected >=2 matching hits');
  expect(must.message).toContain('found 1');
});

test('ids.user_id per consent state', () => {
  const g = hit({ consent: granted, ids: { user_id: true } });
  const d = hit({ consent: denied, ids: { client_id: true } });
  const recs = [g, d];
  expect(rule(`expect:\n  must:\n    - { ids.user_id: present, consent.analytics: granted }`, recs).pass).toBe(true);
  expect(rule(`expect:\n  mustNot:\n    - { ids.user_id: present, consent.analytics: denied }`, recs).pass).toBe(true);
  expect(rule(`expect:\n  mustNot:\n    - { ids.user_id: present }`, recs).pass).toBe(false);
  expect(rule(`expect:\n  must:\n    - { ids.user_id: absent, consent.analytics: denied }`, recs).pass).toBe(true);
});

test('ids with an exact value', () => {
  const h = hit({ ids: { em: 'abc' } as never });
  expect(rule(`expect:\n  must:\n    - { ids.em: abc }`, [h]).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { ids.em: xyz }`, [h]).pass).toBe(false);
});

test('vendor, event, transport, params and page filters', () => {
  const a = hit({ vendor: 'ga4', event: 'purchase', transport: 'beacon', params: { cu: 'USD' } });
  const b = hit({ vendor: 'meta', event: 'Purchase', page: SANDBOX });
  const recs = [a, b];
  const pass = (f: string) => rule(`expect:\n  must:\n    - ${f}`, recs).pass;
  expect(pass('{ vendor: ga4 }')).toBe(true);
  expect(pass('{ vendor: [meta, tiktok] }')).toBe(true);
  expect(pass('{ vendor: pinterest }')).toBe(false);
  expect(pass('{ event: purchase }')).toBe(true);
  expect(pass('{ event: [nope, Purchase] }')).toBe(true);
  expect(pass('{ transport: beacon }')).toBe(true);
  expect(pass('{ transport: xhr }')).toBe(false);
  expect(pass('{ params.cu: USD }')).toBe(true);
  expect(pass('{ params.cu: EUR }')).toBe(false);
  expect(pass(`{ page: "${PAGE}" }`)).toBe(true);
  expect(pass('{ page: { matches: "sandbox" } }')).toBe(true);
  expect(pass('{ vendor: ga4, page: { matches: "sandbox" } }')).toBe(false);
});

test('host and outcome filters read the request', () => {
  const a = hit({}, { url: 'http://127.0.0.1:9000/g/collect', outcome: 'stubbed' });
  const b = hit({ vendor: 'meta' }, { url: 'https://stape.example.com/x', outcome: 'passed' });
  const pass = (f: string) => rule(`expect:\n  must:\n    - ${f}`, [a, b]);
  expect(pass('{ host: "127.0.0.1:9000", outcome: stubbed }').evidence).toEqual([a.hit.id]);
  expect(pass('{ host: stape.example.com }').evidence).toEqual([b.hit.id]);
  expect(pass('{ outcome: passed }').evidence).toEqual([b.hit.id]);
  expect(pass('{ host: nowhere.example.com }').pass).toBe(false);
});

test('counts', () => {
  const recs = [hit(), hit(), hit()];
  const c = (v: string) => rule(`expect:\n  must:\n    - { vendor: ga4, count: "${v}" }`, recs).pass;
  expect(c('>=3')).toBe(true);
  expect(c('>=4')).toBe(false);
  expect(c('<4')).toBe(true);
  expect(c('<3')).toBe(false);
  expect(c('3')).toBe(true);
  expect(c('0')).toBe(false);
  expect(rule(`expect:\n  must:\n    - { vendor: tiktok, count: "0" }`, recs).pass).toBe(true);
});

test('before: consent covers other vendors in the first undecided epoch only', () => {
  const early = hit({ vendor: 'meta', t: 500 });
  const late = hit({ vendor: 'meta', t: 2000 });
  const q = `expect:\n  mustNot:\n    - { vendor: meta, before: consent }`;
  expect(rule(q, [late, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
  const r = rule(q, [early, late, ...UNDECIDED_THEN_ACCEPT]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([early.hit.id]);
});

test('before: consent is false for a later undecided epoch', () => {
  const recs = [epoch(0, 100, 'undecided'), epoch(100, 200, granted), epoch(200, null, 'undecided')];
  expect(rule(`expect:\n  mustNot:\n    - { vendor: meta, before: consent }`, [hit({ vendor: 'meta', t: 300 }), ...recs]).pass).toBe(true);
});

test('grace window: a hit just before the boundary counts as after it', () => {
  const nearBoundary = hit({ vendor: 'meta', t: 960 });
  const q = `expect:\n  mustNot:\n    - { vendor: meta, before: consent }`;
  expect(rule(q, [nearBoundary, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
  const tooEarly = hit({ vendor: 'meta', t: 900 });
  expect(rule(q, [tooEarly, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(false);
  const wide = evaluate([tooEarly.hit, ...UNDECIDED_THEN_ACCEPT] as never, parseScenario(`start: /\n${q}\noptions: { graceWindow: 200ms }`));
  expect(wide[0]!.pass).toBe(true);
});

test('before: consent uses time for Google hits', () => {
  const afterReject = [hit({ consent: denied, t: 5000 }), epoch(0, 1000, 'undecided'), epoch(1000, null, denied)];
  expect(rule(`expect:\n  mustNot:\n    - { vendor: ga4, before: consent }`, afterReject).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { vendor: ga4, before: consent }`, afterReject).pass).toBe(false);
  const grantedEarly = hit({ consent: granted, t: 10 });
  const r = rule(`expect:\n  mustNot:\n    - { vendor: ga4, consent.analytics: granted, before: consent }`, [grantedEarly, ...UNDECIDED_THEN_ACCEPT]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([grantedEarly.hit.id]);
  expect(rule(`expect:\n  must:\n    - { vendor: ga4, in: epoch(granted) }`, [grantedEarly, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { vendor: ga4, in: epoch(undecided) }`, [grantedEarly, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
});

test('consent.* on a non-Google vendor falls back to the epoch', () => {
  const q = `expect:\n  mustNot:\n    - { vendor: meta, consent.ads: denied }`;
  const deniedEpochs = [epoch(0, 1000, 'undecided'), epoch(1000, null, denied)];
  const inDenied = hit({ vendor: 'meta', t: 2000 });
  const r = rule(q, [inDenied, ...deniedEpochs]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([inDenied.hit.id]);
  expect(rule(q, [hit({ vendor: 'meta', t: 2000 }), ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { vendor: meta, consent.ads: granted }`, [hit({ vendor: 'meta', t: 2000 }), ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
  expect(rule(q, [hit({ vendor: 'meta', t: 100 }), ...deniedEpochs]).pass).toBe(true);
});

test('Google hit without consent fields falls back to the epoch', () => {
  const q = `expect:\n  mustNot:\n    - { vendor: ga4, consent.analytics: denied }`;
  const recs = [hit({ t: 2000 }), epoch(0, 1000, 'undecided'), epoch(1000, null, denied)];
  expect(rule(q, recs).pass).toBe(false);
});

test('in: epoch(<state>) with accept then withdraw', () => {
  const recs = [epoch(0, 1000, 'undecided'), epoch(1000, 2000, granted), epoch(2000, null, denied)];
  const m = (t: number, sel: string) => rule(`expect:\n  must:\n    - { vendor: meta, in: "epoch(${sel})" }`, [hit({ vendor: 'meta', t }), ...recs]).pass;
  expect(m(500, 'undecided')).toBe(true);
  expect(m(500, 'granted')).toBe(false);
  expect(m(1500, 'granted')).toBe(true);
  expect(m(1500, 'analytics=granted')).toBe(true);
  expect(m(2500, 'denied')).toBe(true);
  expect(m(2500, 'ads=granted')).toBe(false);
});

test('without epochs a hit is undecided', () => {
  expect(rule(`expect:\n  must:\n    - { vendor: meta, before: consent }`, [hit({ vendor: 'meta' })]).pass).toBe(true);
});

test('after: <step label>', () => {
  const step: Step = { type: 'step', id: newId('step'), runId, index: 0, label: 'accept', startedAt: 900, endedAt: 1000 };
  const before = hit({ vendor: 'meta', t: 950 });
  const after = hit({ vendor: 'meta', t: 1500 });
  const q = `expect:\n  must:\n    - { vendor: meta, after: accept }`;
  const r = rule(q, [step, before, after]);
  expect(r.pass).toBe(true);
  expect(r.evidence).toEqual([after.hit.id]);
  const none = rule(`expect:\n  mustNot:\n    - { vendor: meta, after: accept }`, [step, before]);
  expect(none.pass).toBe(true);
  const missing = rule(q, [before]);
  expect(missing.pass).toBe(false);
  expect(missing.message).toContain('"accept"');
});

test('identity.hashesMatch', () => {
  const em = hashEmail(identity.email);
  const ph = hashPhone(identity.phone);
  const good = hit({ vendor: 'meta', params: { 'ud[em]': em.hex, 'ud[ph]': ph.hex } });
  const goodB64 = hit({ vendor: 'meta', params: { em: em.base64url } });
  const bad = hit({ vendor: 'meta', params: { 'ud[em]': hashEmail('other@example.com').hex } });
  const q = `expect:\n  must:\n    - { vendor: meta, identity.hashesMatch: true }`;
  const ev = (recs: unknown[]) => evaluate(recs.flatMap((r) => [(r as { hit: Hit }).hit, (r as unknown as { req: Request }).req]) as never, parseScenario(`start: /\n${q}`), { identity })[0]!;
  expect(ev([good, goodB64]).pass).toBe(true);
  const failed = ev([good, bad]);
  expect(failed.pass).toBe(false);
  expect(failed.evidence).toEqual([bad.hit.id]);
  expect(ev([hit({ vendor: 'meta' })]).message).toContain('no hashed values');
  expect(rule(q, [good]).message).toContain('no run identity');
  const digitsPhone = hit({ vendor: 'meta', params: {
    'ud[em]': em.hex, 'ud[ph]': hashEmail(identity.phone.replace(/\D/g, '')).hex,
    'ud[fn]': hashEmail(identity.firstName).hex, 'ud[ln]': hashEmail(identity.lastName).hex,
  } });
  expect(ev([digitsPhone]).pass).toBe(true);
  expect(ev([hit({ vendor: 'meta', params: { 'ud[ph]': hashEmail('15550000000').hex } })]).pass).toBe(false);
});

test('built-in unknownDestination fails with evidence unless allowed', () => {
  const flag: Flag = { type: 'flag', id: newId('flag'), runId, kind: 'unknownDestination', recordIds: ['req_X'], detail: 'GET http://127.0.0.1:9100/x' };
  const failing = evaluate([flag], parseScenario('start: /'));
  const check = failing.find((r) => r.expectation === 'builtin: unknownDestination')!;
  expect(check.pass).toBe(false);
  expect(check.evidence).toEqual([flag.id, 'req_X']);
  expect(check.message).toContain('127.0.0.1:9100');
  const allowed = evaluate([flag], parseScenario('start: /\noptions: { allowUnknownDestination: true }'));
  expect(allowed.find((r) => r.expectation === 'builtin: unknownDestination')!.pass).toBe(true);
  expect(evaluate([], parseScenario('start: /')).every((r) => r.pass)).toBe(true);
});

test('built-in sandbox page URL check', () => {
  const bad = hit({ page: SANDBOX });
  const results = run('start: /', [bad]);
  const check = results.find((r) => r.expectation === 'builtin: sandboxPageUrl')!;
  expect(check.pass).toBe(false);
  expect(check.evidence).toEqual([bad.hit.id]);
});

test('built-in possibleRealData comes from flags', () => {
  const flag: Flag = { type: 'flag', id: newId('flag'), runId, kind: 'possibleRealData', recordIds: ['req_Y'], detail: 'email in postData' };
  const check = evaluate([flag], parseScenario('start: /')).find((r) => r.expectation === 'builtin: possibleRealData')!;
  expect(check.pass).toBe(false);
  expect(check.evidence).toContain('req_Y');
});

test('results carry the run id and ids with a prefix', () => {
  const [r] = run('start: /\nexpect:\n  must:\n    - { vendor: ga4 }', [hit()]);
  expect(r!.runId).toBe(runId);
  expect(r!.id.startsWith('rsl_')).toBe(true);
  expect(r!.expectation).toContain('vendor');
});

const partialGranted = { analytics: 'granted', ads: 'granted', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;
const partialDenied = { analytics: 'denied', ads: 'denied', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;
const mixed = { analytics: 'granted', ads: 'denied', adUserData: 'unknown', adPersonalization: 'unknown', raw: {} } as const;

test('epoch(granted) matches hits and epochs that leave some fields unknown', () => {
  const y = 'expect:\n  must:\n    - { in: epoch(granted) }';
  expect(rule(y, [hit({ consent: partialGranted })]).pass).toBe(true);
  expect(rule(y, [hit({ vendor: 'meta', t: 10 }), epoch(0, null, partialGranted)]).pass).toBe(true);
  expect(rule(y, [hit({ consent: mixed })]).pass).toBe(false);
  expect(rule(y, [hit({ consent: allUnknown })]).pass).toBe(false);
});

test('epoch(denied) matches hits and epochs that leave some fields unknown', () => {
  const y = 'expect:\n  must:\n    - { in: epoch(denied) }';
  expect(rule(y, [hit({ consent: partialDenied })]).pass).toBe(true);
  expect(rule(y, [hit({ vendor: 'meta', t: 10 }), epoch(0, null, partialDenied)]).pass).toBe(true);
  expect(rule(y, [hit({ consent: mixed })]).pass).toBe(false);
});
