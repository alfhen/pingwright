import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { createIdentity, hashEmail, hashPhone, readRun, type TagreeveRecord } from '../../../packages/core/src/index.ts';
import { demoDir, demoLeaks, demoScenarios, demoSeeds, rewriteHosts, scrubRecords } from '../../../scripts/record-site-demo.ts';
import { checkReply, demoHits, HIT_WINDOW, loadDemo, parseReply, recordedExitCode } from './demo-data.ts';

const dir = fileURLToPath(new URL('../../demo/', import.meta.url));
const records = (s: string) => readRun(join(dir, `${s}.jsonl`));

test('the committed demo loads, and every reply matches its record', async () => {
  const demo = await loadDemo(dir);
  expect(demo.scenarios.map((s) => s.key)).toEqual(['undecided', 'reject', 'accept']);
  expect(demo.commands.map((c) => c.key)).toEqual(['run', 'diff', 'suite', 'json']);
});

test('the run and --json panels show the same reject run', async () => {
  const demo = await loadDemo(dir);
  const text = (key: string) => demo.commands.find((c) => c.key === key)!.lines.map((l) => l.text).join('\n');
  const first = (await records('reject')).results[0]!;
  for (const id of first.evidence) {
    expect(text('run')).toContain(id);
    expect(text('json')).toContain(`"${id}"`);
  }
  expect(text('json')).toContain(JSON.stringify(first.message));
});

test('each exit code is the one the recorded "Result:" line reports', async () => {
  const demo = await loadDemo(dir);
  for (const s of demo.scenarios) {
    const result = /^Result: (pass|fail)/m.exec(readFileSync(join(dir, `${s.key}.txt`), 'utf8'))![1];
    expect(s.exitCode, s.key).toBe(result === 'pass' ? 0 : 1);
    expect(s.verdict.exit).toBe(`exit ${s.exitCode}`);
    expect(s.toolOut.at(-1)!.text).toBe(`exit ${s.exitCode}`);
  }
  expect(recordedExitCode('Result: pass with 1 warning\n', 'x')).toBe(0);
  expect(() => recordedExitCode('Run failed: boom\n', 'x.txt')).toThrow(/x\.txt/);
});

describe('checkReply', () => {
  test('throws on an evidence ID that is not in the record, and names it', async () => {
    const reject = await records('reject');
    expect(() => checkReply('Evidence: hit_…ZZZZ.', reject, 1, 'reject.reply.md')).toThrow(/hit_…ZZZZ/);
    const full = 'hit_01ZZZZZZZZZZZZZZZZZZZZZZZZ';
    expect(() => checkReply(`Evidence: ${full}.`, reject, 1, 'reject.reply.md')).toThrow(full);
  });

  test('throws on a real hit that is not the evidence of a failed rule', async () => {
    const reject = await records('reject');
    const passing = 'hit_01M6FCPCWWB6RJ46R07RPRZ6CB';
    expect(reject.hits.map((h) => h.id)).toContain(passing);
    expect(() => checkReply('Evidence: hit_…Z6CB.', reject, 1, 'reject.reply.md')).toThrow(/hit_…Z6CB is not the evidence of a failed rule/);
    expect(() => checkReply(`Evidence: ${passing}.`, reject, 1, 'reject.reply.md')).toThrow(passing);
    const warned = reject.results.find((r) => !r.pass && r.severity === 'warn')!.evidence[0]!;
    expect(() => checkReply(`Evidence: ${warned}.`, reject, 1, 'reject.reply.md')).toThrow(warned);
  });

  test('throws on a number that is not in the record, and names it', async () => {
    const reject = await records('reject');
    expect(() => checkReply('Meta fires before the answer (9999 hits).', reject, 1, 'reject.reply.md')).toThrow(/number 9999/);
  });

  test('accepts the IDs and numbers of the record, list markers and words with digits', async () => {
    const reject = await records('reject');
    const failed = reject.results.find((r) => !r.pass)!;
    const tail = failed.evidence[0]!.slice(-4);
    expect(() => checkReply(`1. GA4 sends ${failed.evidence.length} hits.\n2. Evidence: hit_…${tail}, ${failed.evidence[0]}.`, reject, 1, 'x')).not.toThrow();
  });

  test('parseReply keeps line breaks inside a paragraph', () => {
    const reply = parseReply('## plan\n\nPlan.\n\n## verdict\n\nTitle\n\nBody.\n\n## reply\n\nOne.\n\n1. a\n2. b\n', 'x');
    expect(reply).toEqual({ plan: 'Plan.', verdict: { title: 'Title', body: 'Body.' }, reply: ['One.', '1. a\n2. b'] });
  });
});

describe.each(demoScenarios)('the %s hits', (s) => {
  test('are the record hit records, in order, with times inside the demo window', async () => {
    const run = await records(s);
    const hits = demoHits(run);
    expect(hits.map((h) => [h.id, h.vendor, h.event])).toEqual(run.hits.map((h) => [h.id, h.vendor, h.event ?? '(no event)']));
    const times = hits.map((h) => h.at);
    expect(Math.min(...times)).toBe(HIT_WINDOW[0]);
    expect(Math.max(...times)).toBe(HIT_WINDOW[1]);
    for (const h of hits) expect(h.at).toBeGreaterThanOrEqual(HIT_WINDOW[0]);
  });

  test('get the fail style from the failed results of the record', async () => {
    const run = await records(s);
    const evidence = new Set(run.results.filter((r) => !r.pass && r.severity !== 'warn').flatMap((r) => r.evidence));
    const failing = demoHits(run).filter((h) => h.fail).map((h) => h.id);
    expect(failing.length).toBeGreaterThan(0);
    expect(new Set(failing)).toEqual(new Set(run.hits.filter((h) => evidence.has(h.id)).map((h) => h.id)));
  });
});

describe('no demo file holds identity data', () => {
  const identities = Object.entries(demoSeeds).map(([name, seed]) => {
    const { email, phone } = createIdentity(seed);
    return { name, email, phone, hashes: [...Object.values(hashEmail(email)), ...Object.values(hashPhone(phone))] };
  });

  function scan(text: string): string[] {
    const found = identities.flatMap((i) => [i.email, i.phone, ...i.hashes].filter((v) => text.includes(v)));
    for (const marker of ['identitySeed', 'pw_consent=', 'northwind.dk']) if (text.includes(marker)) found.push(marker);
    return found;
  }

  function files(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]));
  }

  test('the email, the phone, their SHA-256 forms, the seed, a consent cookie value and the old host are absent', () => {
    const all = files(demoDir);
    expect(all.length).toBeGreaterThan(10);
    for (const file of all) {
      const text = readFileSync(file, 'utf8');
      expect(scan(text), file).toEqual([]);
      expect(demoLeaks(text), file).toEqual([]);
    }
  });

  test('the scan finds a rebuilt email, a hash and a cookie value (positive control)', () => {
    const reject = identities.find((i) => i.name === 'reject')!;
    expect(scan(`Record: x\n  contact ${reject.email}\n`)).toEqual([reject.email]);
    expect(scan(reject.hashes[0]!)).toEqual([reject.hashes[0]]);
    expect(scan('cookie: pw_consent=reject')).toEqual(['pw_consent=']);
    expect(demoLeaks(`a ${reject.email} b`)).toContain(reject.email);
    expect(demoLeaks('GET https://www.facebook.com/tr/')).toEqual(['https://www.facebook.com/tr/']);
    expect(demoLeaks('GET http://127.0.0.1:5555/unknown-pixel')).toEqual(['127.0.0.1:5555']);
    expect(demoLeaks('unknownDestination: localhost:5555 x2')).toEqual(['localhost:5555']);
    expect(demoLeaks('GET https://staging.northwind.example/ and https://pixel.adnetwork.example/x')).toEqual([]);
  });
});

test('scrubRecords drops the identity, the seed, values, headers and every request to a host that is not loopback', () => {
  const identity = createIdentity(demoSeeds.reject);
  const base = { runId: 'run_1', stepId: null, t: 1 };
  const input = [
    { type: 'run', id: 'run_1', scenario: 's', site: 'http://localhost:1', startedAt: 0, identity, identitySeed: demoSeeds.reject },
    { ...base, type: 'request', id: 'req_1', method: 'GET', url: 'http://localhost:1/p?em=x', resourceType: 'image', frameUrl: 'http://localhost:1/?a=b', initiator: 'x', headers: { cookie: 'pw_consent=accept' }, postData: 'a', outcome: 'passed' },
    { ...base, type: 'request', id: 'req_2', method: 'GET', url: 'https://www.facebook.com/tr/?id=1', resourceType: 'image', frameUrl: null, initiator: null, headers: {}, postData: null, outcome: 'stubbed' },
    { ...base, type: 'hit', id: 'hit_1', requestId: 'req_2', vendor: 'meta', event: 'PageView', consent: { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown', raw: { gcs: 'G100', fbp: 'fb.1.2' } }, ids: { hashes: { em: { present: true, matchesIdentity: true } } }, page: 'http://localhost:1/?q=1', transport: 'image', params: { fbp: 'fb.1.2', 'ud[em]': hashEmail(identity.email).hex } },
    { ...base, type: 'checkpoint', id: 'ckp_1', label: 'c', consentState: null, cookies: [] },
    { ...base, type: 'dataLayerEvent', id: 'dle_1', event: null, gtmUniqueEventId: null, args: [identity.email], isConsentCommand: false },
  ] as unknown as TagreeveRecord[];
  const out = scrubRecords(input);
  const text = out.map((r) => JSON.stringify(r)).join('\n');
  expect(out.map((r) => r.id)).toEqual(['run_1', 'req_1', 'hit_1']);
  expect(demoLeaks(rewriteHosts(text, origins))).toEqual([]);
  expect(text).not.toContain('fb.1.2');
  expect(text).not.toContain('em=x');
  expect(text).not.toContain('"x"');
});

const origins = { url: 'http://localhost:1', sgtmUrl: 'http://127.0.0.1:5', thirdPartyUrl: 'http://127.0.0.1:51', containerUrl: 'http://127.0.0.1:52', paymentFrameUrl: 'http://127.0.0.1:53' };

test('rewriteHosts puts a demo host in place of each fixture origin, and leaves no loopback host', () => {
  const text = [
    '"site":"http://localhost:1","page":"http://localhost/products/fake-tee"',
    'GET http://127.0.0.1:5/pwstape and http://127.0.0.1:51/unknown-pixel',
    'unknownDestination: 127.0.0.1:51 x2 (/unknown-pixel)',
  ].join('\n');
  expect(rewriteHosts(text, origins)).toBe(
    [
      '"site":"https://staging.northwind.example","page":"https://staging.northwind.example/products/fake-tee"',
      'GET https://sgtm.northwind.example/pwstape and https://pixel.adnetwork.example/unknown-pixel',
      'unknownDestination: pixel.adnetwork.example x2 (/unknown-pixel)',
    ].join('\n'),
  );
});
