import { createHash } from 'node:crypto';
import {
  createIdentity,
  hashEmail,
  hashPhone,
  newId,
  type ConsentState,
  type Flag,
  type Hit,
  type Request,
  type Step,
} from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest } from '@pingwright/decoders';
import { epochForHit, evaluate, placeHitsInEpochs, type EvalEpoch } from './evaluate.ts';
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

function labelFor(state: ConsentState | 'undecided'): EvalEpoch['label'] {
  if (state === 'undecided') return 'undecided';
  const known = [state.analytics, state.ads, state.adUserData, state.adPersonalization].filter((v) => v !== 'unknown');
  if (known.length > 0 && known.every((v) => v === 'granted')) return 'granted';
  if (known.length > 0 && known.every((v) => v === 'denied')) return 'denied';
  return 'mixed';
}

function epoch(startT: number, endT: number | null, state: ConsentState | 'undecided', label = labelFor(state)): EvalEpoch {
  return { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT, source: 'test', label, ...(label === 'withdrawn' && state !== 'undecided' ? { outcome: labelFor(state) as 'granted' | 'denied' | 'mixed' } : {}), state: state === 'undecided' ? allUnknown : state };
}

const UNDECIDED_THEN_ACCEPT = [epoch(0, 1000, 'undecided'), epoch(1000, null, granted)];

function run(yaml: string, records: unknown[]) {
  const flat = records.flatMap((r) => (r && typeof r === 'object' && 'hit' in r ? [(r as { hit: Hit }).hit, (r as unknown as { req: Request }).req] : [r]));
  return evaluate(flat as never, parseScenario(yaml), { identity });
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
  expect(pass('{ vendor: [meta, sgtm] }')).toBe(true);
  expect(pass('{ vendor: sgtm }')).toBe(false);
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
  expect(rule(`expect:\n  must:\n    - { vendor: sgtm, count: "0" }`, recs).pass).toBe(true);
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

test('before: consent with a granted filter is flagged when the first epoch is decided', () => {
  const r = rule(`expect:\n  mustNot:\n    - { vendor: meta, consent.analytics: granted, before: consent }`, [epoch(1000, null, granted)]);
  expect(r.message).toContain('cannot match');
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
  const q = `steps:\n  - { consent: accept, label: accept }\nexpect:\n  must:\n    - { vendor: meta, after: accept }`;
  const r = rule(q, [step, before, after]);
  expect(r.pass).toBe(true);
  expect(r.evidence).toEqual([after.hit.id]);
  const none = rule(`steps:\n  - { consent: accept, label: accept }\nexpect:\n  mustNot:\n    - { vendor: meta, after: accept }`, [step, before]);
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
  const none = ev([hit({ vendor: 'meta' })]);
  expect(none.message).toBe(
    'Expected >=1 hits matching all conditions, found 0. 1 hit matched vendor, but identity.hashesMatch failed: it carried no hashed email or phone values.',
  );
  expect(none.message).not.toContain('found 1 matching hit');
  expect(failed.message).toContain('found 1. 2 hits matched vendor, but identity.hashesMatch failed: the hashed email or phone values in 1 hit(s) do not match');
  const noIdentity = evaluate([good.hit, good.req], parseScenario(`start: /\n${q}`))[0]!;
  expect(noIdentity.message).toContain('no run identity');
  const digitsPhone = hit({ vendor: 'meta', params: {
    'ud[em]': em.hex, 'ud[ph]': hashEmail(identity.phone.replace(/\D/g, '')).hex,
    'ud[fn]': hashEmail(identity.firstName).hex, 'ud[ln]': hashEmail(identity.lastName).hex,
  } });
  expect(ev([digitsPhone]).pass).toBe(true);
  expect(ev([hit({ vendor: 'meta', params: { 'ud[ph]': hashEmail('15550000000').hex } })]).pass).toBe(false);
  const plain = ev([good, hit({ vendor: 'meta', params: { 'ud[em]': identity.email } })]);
  expect(plain.pass).toBe(false);
  expect(plain.message).toContain('unhashed');
  expect(ev([hit({ vendor: 'meta', params: { hashedPhone: identity.phone } })]).message).toContain('unhashed');
  expect(ev([good, hit({ vendor: 'meta', params: { 'ud[em]': em.hex.toUpperCase() } })]).pass).toBe(false);
  expect(ev([good, hit({ vendor: 'meta', params: { 'ud[em]': 'a'.repeat(40) } })]).pass).toBe(false);
  expect(ev([hit({ vendor: 'meta', params: { hashedEmail: em.hex } })]).pass).toBe(true);
});

test('built-in unknownDestination fails with evidence unless allowed', () => {
  const flag: Flag = { type: 'flag', id: newId('flag'), runId, kind: 'unknownDestination', recordIds: ['req_X'], detail: 'GET http://127.0.0.1:9100/x' };
  const failing = evaluate([flag], parseScenario('start: /'));
  const check = failing.find((r) => r.expectation === 'builtin: unknownDestination')!;
  expect(check.pass).toBe(false);
  expect(check.evidence).toEqual([flag.id, 'req_X']);
  expect(check.message).toContain('127.0.0.1 x1');
  const allowed = evaluate([flag], parseScenario('start: /\noptions: { allowUnknownDestination: true }'));
  expect(allowed.find((r) => r.expectation === 'builtin: unknownDestination')!.pass).toBe(true);
  expect(evaluate([], parseScenario('start: /'), { identity }).every((r) => r.pass)).toBe(true);
});

test('allowUnknownDestination as a host list passes only those hosts', () => {
  const mk = (url: string): Flag => ({ type: 'flag', id: newId('flag'), runId, kind: 'unknownDestination', recordIds: [], detail: `GET ${url}` });
  const flags = [mk('https://i.guim.co.uk/a?x=1'), mk('https://img.shopifycdn.com/b?x=1'), mk('https://tracker.example.net/c?x=1')];
  const check = (opts: string) =>
    evaluate(flags, parseScenario(`start: /\noptions: { allowUnknownDestination: ${opts} }`)).find((r) => r.expectation === 'builtin: unknownDestination')!;
  const partial = check("['i.guim.co.uk', '*.shopifycdn.com']");
  expect(partial.pass).toBe(false);
  expect(partial.message).toContain('tracker.example.net x1');
  expect(partial.message).not.toContain('guim');
  expect(check("['i.guim.co.uk', '*.shopifycdn.com', 'tracker.example.net']").pass).toBe(true);
  expect(check("['shopifycdn.com']").pass).toBe(false);
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

test('possibleRealData scans requests when only the identity is given', () => {
  const foreign = Buffer.from('{"em":"someone.else@example.com"}').toString('base64');
  const bad = hit({}, { postData: foreign, stepId: 'stp_X' as Request['stepId'] });
  const clean = hit({}, { postData: Buffer.from(identity.email).toString('base64') });
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  const check = find(evaluate([bad.hit, bad.req, clean.hit, clean.req], parseScenario('start: /'), { identity }));
  expect(check.pass).toBe(false);
  expect(check.evidence).toEqual([bad.req.id, bad.hit.id, 'stp_X']);
  expect(find(evaluate([clean.hit, clean.req], parseScenario('start: /'), { identity })).pass).toBe(true);
});

test('possibleRealData ignores random hashes in decoded hit params but not identity keys', () => {
  const h = createHash('sha256').update('random-controller').digest('hex');
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  const run = (params: Record<string, string>) => {
    const { hit: h1, req } = hit({ params });
    return find(evaluate([h1, req], parseScenario('start: /'), { identity })).pass;
  };
  expect(run({ user_id: h, client_id_hash: h, external_id: h })).toBe(true);
  expect(run({ external_id: h })).toBe(false);
  expect(run({ hmac: h })).toBe(true);
  expect(run({ em: h })).toBe(false);
  expect(run({ 'ud[em]': h })).toBe(false);
});

test('possibleRealData ignores random hashes under exempt keys in raw Meta and GA4 requests', () => {
  const h = createHash('sha256').update('random-client').digest('hex');
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  const passes = (req: Request) => {
    const hits = decodeRequest(req);
    expect(hits.length).toBeGreaterThan(0);
    return find(evaluate([req, ...hits], parseScenario('start: /'), { identity })).pass;
  };
  const meta = new URLSearchParams({ id: '100000000000001', ev: 'PageView', 'ud[external_id]': h, 'cd[user_id]': h });
  expect(passes(request({ url: `https://www.facebook.com/tr/?${meta}` }))).toBe(true);
  const boundary = '----pw';
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="id"\r\n\r\n100000000000001\r\n--${boundary}\r\nContent-Disposition: form-data; name="ev"\r\n\r\nPageView\r\n--${boundary}\r\nContent-Disposition: form-data; name="ud[external_id]"\r\n\r\n${h}\r\n--${boundary}\r\nContent-Disposition: form-data; name="ud[uid]"\r\n\r\n${h}\r\n--${boundary}--\r\n`;
  expect(
    passes(request({ method: 'POST', url: 'https://www.facebook.com/tr/', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, postData: multipart, resourceType: 'ping' })),
  ).toBe(true);
  const ga4 = new URLSearchParams({ v: '2', tid: 'G-PWTEST0001', cid: '1.2', en: 'purchase', uid: h, 'ep.external_id': h });
  expect(passes(request({ url: `https://www.google-analytics.com/g/collect?${ga4}` }))).toBe(true);
});

test('possibleRealData skips a hash repeated under ID keys but not a hashed non-identity email under external_id', () => {
  const client = createHash('sha256').update('fixture-client-id').digest('hex');
  const email = createHash('sha256').update('someone.else@example.com').digest('hex');
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  const check = (params: Record<string, string>[]) => {
    const parts = params.map((p) => hit({ params: p }));
    return find(evaluate(parts.flatMap((x) => [x.hit, x.req]), parseScenario('start: /'), { identity }));
  };
  const ids = (h: string) => ({ clientIdHash: h, external_id: h, uid: h, user_id: h, id: h, uuid: h });
  expect(check([ids(client), ids(client)]).pass).toBe(true);
  const leak = check([ids(client), { external_id: email }]);
  expect(leak.pass).toBe(false);
  expect(leak.message).toContain('not from the run identity');
  expect(check([ids(client), { external_id: email, em: email }]).pass).toBe(false);
});

test('possibleRealData ignores hashes in script load URLs', () => {
  const url = `https://connect.facebook.net/signals/config/100000000000001?hme=${'ab'.repeat(32)}`;
  const script = hit({}, { url, resourceType: 'script' });
  const pixel = hit({}, { url, resourceType: 'image' });
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  expect(find(evaluate([script.req], parseScenario('start: /'), { identity })).pass).toBe(true);
  expect(find(evaluate([pixel.req], parseScenario('start: /'), { identity })).pass).toBe(false);
});

test('possibleRealData ignores hashes in asset paths but scans their queries', () => {
  const sha = 'ef'.repeat(32);
  const asset = hit({}, { url: `https://cdn.example.com/assets/${sha}.png`, resourceType: 'image' });
  const tracked = hit({}, { url: `https://cdn.example.com/p.gif?em=${sha}`, resourceType: 'image' });
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  expect(find(evaluate([asset.req], parseScenario('start: /'), { identity })).pass).toBe(true);
  expect(find(evaluate([tracked.req], parseScenario('start: /'), { identity })).pass).toBe(false);
});

test('possibleRealData still finds emails, base64 payloads and phones in pixel paths', () => {
  const payload = Buffer.from('{"em":"someone.else@example.com"}').toString('base64url');
  const find = (rs: ReturnType<typeof evaluate>) => rs.find((r) => r.expectation === 'builtin: possibleRealData')!;
  for (const url of [
    'https://px.tracker.example/u/someone.else@example.com/p.gif',
    `https://px.tracker.example/c/${payload}/p.gif`,
    'https://px.tracker.example/t/+15550199999/p.gif',
  ]) {
    const pixel = hit({}, { url, resourceType: 'image' });
    expect(find(evaluate([pixel.req], parseScenario('start: /'), { identity })).pass, url).toBe(false);
  }
});

test('possibleRealData still scans script-type conversion hits', () => {
  const sha = 'cd'.repeat(32);
  const ads = hit({ vendor: 'google-ads', event: 'conversion' }, { url: `https://www.googleadservices.com/pagead/conversion/AW-000000001/?em=${sha}`, resourceType: 'script' });
  const check = evaluate([ads.hit, ads.req], parseScenario('start: /'), { identity }).find((r) => r.expectation === 'builtin: possibleRealData')!;
  expect(check.pass).toBe(false);
});

test('possibleRealData cannot be evaluated without identity or flags', () => {
  const check = evaluate([], parseScenario('start: /')).find((r) => r.expectation === 'builtin: possibleRealData')!;
  expect(check.pass).toBe(false);
  expect(check.message).toContain('Cannot check');
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

test('the identity is read from the Run record', () => {
  const runRecord = {
    type: 'run', id: runId, scenario: 's', site: 'http://localhost:3000', startedAt: 0, pingwrightVersion: '0.0.0',
    browser: { name: 'chromium', version: '0' }, networkMode: 'stub', gtmOverride: null, containerVersions: {},
    identity: { ...identity },
  };
  const good = hit({ vendor: 'meta', params: { hashedEmail: hashEmail(identity.email).hex } });
  const q = parseScenario('start: /\nexpect:\n  must:\n    - { vendor: meta, identity.hashesMatch: true }');
  expect(evaluate([runRecord, good.hit, good.req] as never, q)[0]!.pass).toBe(true);
  const foreign = hit({}, { postData: Buffer.from('{"em":"someone.else@example.com"}').toString('base64') });
  const rs = evaluate([runRecord, foreign.hit, foreign.req] as never, parseScenario('start: /'));
  expect(rs.find((r) => r.expectation === 'builtin: possibleRealData')!.pass).toBe(false);
});

test('placeHitsInEpochs skips Google hits and puts a hit in the grace window in the new epoch', () => {
  const epoch = (startT: number): EvalEpoch => ({ type: 'consentEpoch', id: newId('consentEpoch'), runId, startT, endT: null, source: 'test', label: 'undecided', state: allUnknown });
  const epochs = [epoch(0), epoch(1000)];
  const late = { vendor: 'meta', t: 960 } as Hit;
  const early = { vendor: 'meta', t: 900 } as Hit;
  const placed = placeHitsInEpochs([late, early, { vendor: 'ga4', t: 2000 } as Hit], epochs, 50);
  expect(placed.size).toBe(2);
  expect(placed.get(late)).toBe(epochs[1]);
  expect(placed.get(early)).toBe(epochs[0]);
});

test('epoch(denied) judges a non-Google hit by the label when a reject is followed by a mixed Consent Mode update', () => {
  const mixed: ConsentState = { ...denied, analytics: 'granted' };
  const recs = [epoch(0, 1000, 'undecided'), epoch(1000, null, mixed, 'denied')];
  const y = 'expect:\n  mustNot:\n    - { vendor: meta, in: epoch(denied) }';
  expect(rule(y, [hit({ vendor: 'meta', t: 2000 }), ...recs]).pass).toBe(false);
});

test('consent field filters use the state recorded for an undecided epoch', () => {
  const undecidedDenied: EvalEpoch = { ...epoch(0, null, 'undecided'), state: denied };
  const q = `expect:\n  must:\n    - { vendor: meta, consent.analytics: denied }`;
  expect(rule(q, [hit({ vendor: 'meta', t: 500 }), undecidedDenied]).pass).toBe(true);
});

test('a hit before a decided first epoch belongs to no epoch', () => {
  const decided = epoch(1000, null, granted);
  const early = hit({ vendor: 'meta', t: 500 });
  expect(rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(granted) }', [early, decided]).pass).toBe(true);
  expect(rule('expect:\n  must:\n    - { vendor: meta, before: consent }', [early, decided]).pass).toBe(true);
  expect(epochForHit([decided], 500)).toBeUndefined();
  expect(epochForHit([epoch(1000, null, 'undecided')], 500)?.label).toBe('undecided');
});

test('a Google hit with gcs but no gcd leaves the other fields unknown', () => {
  const gcsOnly = hit({ consent: { ...allUnknown, analytics: 'granted', ads: 'granted' }, t: 2000 });
  const q = (field: string) => `expect:\n  must:\n    - { vendor: ga4, consent.${field}: granted }`;
  expect(rule(q('analytics'), [gcsOnly, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
  expect(rule(q('adUserData'), [gcsOnly, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(false);
  const bare = hit({ t: 2000 });
  expect(rule(q('adUserData'), [bare, ...UNDECIDED_THEN_ACCEPT]).pass).toBe(true);
});

test('grace window does not move a hit before a withdraw into the denied epoch', () => {
  const epochs = [epoch(0, 1000, 'undecided'), epoch(1000, 5000, granted), epoch(5000, null, denied, 'withdrawn')];
  const beforeWithdraw = hit({ vendor: 'meta', t: 4980 });
  const afterWithdraw = hit({ vendor: 'meta', t: 5010 });
  const q = 'expect:\n  mustNot:\n    - { vendor: meta, in: epoch(denied) }';
  expect(rule(q, [beforeWithdraw, ...epochs]).pass).toBe(true);
  const r = rule(q, [afterWithdraw, ...epochs]);
  expect(r.pass).toBe(false);
  expect(r.evidence).toEqual([afterWithdraw.hit.id]);
});

test('grace window does not move a hit before a partial withdraw into the new epoch', () => {
  const adsDenied: ConsentState = { ...granted, ads: 'denied' };
  const epochs = [epoch(0, 1000, 'undecided'), epoch(1000, 5000, granted), epoch(5000, null, adsDenied, 'withdrawn')];
  const beforeWithdraw = hit({ vendor: 'meta', t: 4980 });
  const q = 'expect:\n  mustNot:\n    - { vendor: meta, in: epoch(label=withdrawn) }';
  expect(rule(q, [beforeWithdraw, ...epochs]).pass).toBe(true);
  expect(rule(q, [hit({ vendor: 'meta', t: 5010 }), ...epochs]).pass).toBe(false);
});

test('a first reject keeps the grace window', () => {
  const epochs = [epoch(0, 1000, 'undecided'), epoch(1000, null, denied)];
  expect(epochForHit(epochs, 980)?.label).toBe('denied');
});

test('in: epoch(label=withdrawn) matches a withdrawn epoch and epoch(denied) still matches it by state', () => {
  const epochs = [epoch(0, 1000, 'undecided'), epoch(1000, 2000, granted), epoch(2000, null, denied, 'withdrawn')];
  const after = hit({ vendor: 'meta', t: 2500 });
  const byLabel = rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(label=withdrawn) }', [after, ...epochs]);
  expect(byLabel.pass).toBe(false);
  expect(byLabel.evidence).toEqual([after.hit.id]);
  expect(rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(denied) }', [after, ...epochs]).pass).toBe(false);
  expect(rule('expect:\n  must:\n    - { vendor: ga4, in: epoch(label=withdrawn) }', [hit({ t: 2500 }), ...epochs]).pass).toBe(true);
});

test('a banner reject that leaves two signals granted is epoch(denied) as a withdrawal too', () => {
  const partial: ConsentState = { analytics: 'denied', ads: 'denied', adUserData: 'granted', adPersonalization: 'granted' };
  const epochs = [epoch(0, 1000, 'undecided'), epoch(1000, 3000, granted), { ...epoch(3000, null, partial, 'withdrawn'), outcome: 'denied' as const }];
  const after = hit({ vendor: 'meta', t: 4000 });
  expect(rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(denied) }', [after, ...epochs]).pass).toBe(false);
  expect(rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(label=withdrawn) }', [after, ...epochs]).pass).toBe(false);
});

test('in: epoch(label=withdrawn) matches nothing in a reject-only run', () => {
  const epochs = [epoch(0, 1000, 'undecided'), epoch(1000, null, denied)];
  const after = hit({ vendor: 'meta', t: 2500 });
  expect(rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(label=withdrawn) }', [after, ...epochs]).pass).toBe(true);
  expect(rule('expect:\n  mustNot:\n    - { vendor: meta, in: epoch(denied) }', [after, ...epochs]).pass).toBe(false);
});

test('before: consent with a consent filter that cannot match says so', () => {
  const recs = [hit({ vendor: 'meta', t: 10 }), epoch(0, null, 'undecided')];
  const r = rule('expect:\n  mustNot:\n    - { vendor: meta, consent.analytics: granted, before: consent }', recs);
  expect(r.pass).toBe(true);
  expect(r.message).toContain('This rule cannot match');
  const ok = rule('expect:\n  mustNot:\n    - { vendor: meta, before: consent }', recs);
  expect(ok.message).not.toContain('cannot match');
  const google = rule('expect:\n  mustNot:\n    - { vendor: ga4, consent.analytics: granted, before: consent }', recs);
  expect(google.message).not.toContain('cannot match');
});

test('a phone hash in an email field does not match', () => {
  const ph = hashPhone(identity.phone);
  const q = parseScenario('start: /\nexpect:\n  must:\n    - { vendor: meta, identity.hashesMatch: true }');
  const swapped = hit({ vendor: 'meta', params: { em: ph.hex } });
  expect(evaluate([swapped.hit, swapped.req] as never, q, { identity })[0]!.pass).toBe(false);
});

test('ids.hashes.* reads hashed ids and whether they match the identity', () => {
  const h = hit({ ids: { hashes: { em: { present: true, matchesIdentity: true }, ph: { present: true, matchesIdentity: false } } } });
  const recs = [h];
  expect(rule(`expect:\n  must:\n    - { ids.hashes.em: present }`, recs).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { ids.hashes.em.matchesIdentity: true }`, recs).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { ids.hashes.ph.matchesIdentity: true }`, recs).pass).toBe(false);
  expect(rule(`expect:\n  must:\n    - { ids.hashes.ph.matchesIdentity: false }`, recs).pass).toBe(true);
  expect(rule(`expect:\n  must:\n    - { ids.hashes.fn: absent }`, recs).pass).toBe(true);
  expect(rule(`expect:\n  mustNot:\n    - { ids.hashes.em: present }`, recs).pass).toBe(false);
});

test('ids.hashes.*.matchesIdentity: null means not compared and satisfies neither true nor false', () => {
  const recs = [hit({ ids: { hashes: { em: { present: true, matchesIdentity: null } } } })];
  expect(rule(`expect:\n  must:\n    - { ids.hashes.em.matchesIdentity: true }`, recs).pass).toBe(false);
  expect(rule(`expect:\n  must:\n    - { ids.hashes.em.matchesIdentity: false }`, recs).pass).toBe(false);
  expect(rule(`expect:\n  must:\n    - { ids.hashes.em: present }`, recs).pass).toBe(true);
});
