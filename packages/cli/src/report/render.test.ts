import { newId, RunWriter, type PingwrightRecord, type Result, type RunRecords } from '@pingwright/core';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { parseCli } from '../args.ts';
import { main } from '../main.ts';
import { buildReportModel } from './model.ts';
import { CSP, escapeHtml, renderReport } from './render.ts';

const EMAIL = 'pw-fixture@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');
const PHONE = '+46701740620';
const COOKIE = 'pwfake-cookie-value-0001';
const AUTH = '[redacted]';

const runId = newId('run');
const consent = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied', raw: { gcs: 'G100', secret: COOKIE } } as const;
const DENIED = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' } as const;

function records(extra: Partial<RunRecords> = {}): RunRecords {
  const request = {
    type: 'request' as const,
    id: newId('request'),
    runId,
    stepId: null,
    t: 1500,
    method: 'POST',
    url: `https://collect.example.com/g/collect?em=${HASH}&gtmAuth=${AUTH}`,
    resourceType: 'fetch',
    frameUrl: null,
    initiator: null,
    headers: { cookie: `_pwid=${COOKIE}` },
    postData: JSON.stringify({ email: EMAIL, hash: HASH, phone: PHONE }),
    outcome: 'stubbed' as const,
  };
  const hit = {
    type: 'hit' as const,
    id: newId('hit'),
    runId,
    stepId: null,
    requestId: request.id,
    t: 1500,
    vendor: 'sgtm',
    event: '<script>alert(1)</script>',
    consent: { ...consent },
    ids: { hashes: { em: { present: true, matchesIdentity: true } } },
    page: `https://shop.example.com/?email=${EMAIL}`,
    transport: 'fetch',
    params: { em: HASH, cookie: COOKIE },
    fields: ['event_name', `user_data.${HASH}`, PHONE.replace('+', '') + '.x', EMAIL],
    fieldsComplete: true,
    idFields: ['external_id', `user_data.${HASH}`],
  };
  return {
    run: {
      type: 'run',
      id: runId,
      recordSchemaVersion: 2,
      scenario: '<img src=x onerror=alert(1)>.yml',
      site: `https://shop.example.com/products/${EMAIL}?q=${HASH}`,
      startedAt: 1_800_000_000_000,
      pingwrightVersion: '0.3.0',
      browser: { name: 'chromium', version: '156' },
      networkMode: 'stub',
      gtmOverride: { container: 'GTM-PWTEST1', gtmPreview: 'env-1', gtmAuth: '[redacted]', expectedTags: [], applied: [] },
      containerVersions: {},
      identity: null,
    },
    steps: [{ type: 'step', id: newId('step'), runId, index: 0, label: '<script>step()</script>', startedAt: 0, endedAt: 1, error: `failed for ${EMAIL}` }],
    requests: [request],
    responses: [],
    hits: [hit],
    dataLayerEvents: [{ type: 'dataLayerEvent', id: newId('dataLayerEvent'), runId, stepId: null, t: 1, event: 'purchase', gtmUniqueEventId: 1, args: [{ email: EMAIL }], isConsentCommand: false }],
    tagReports: [],
    consentEpochs: [
      { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: 0, endT: 1000, source: 'test', label: 'undecided', state: { ...DENIED, analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown' } },
      { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: 1000, endT: null, source: 'test', label: 'denied', state: { ...DENIED } },
    ],
    checkpoints: [{ type: 'checkpoint', id: newId('checkpoint'), runId, stepId: null, label: 'c', consentState: null, cookies: [{ name: `_pwid_${COOKIE}`, domain: 'example.com', expires: null, firstParty: true }] }],
    results: [
      {
        type: 'result',
        id: newId('result'),
        runId,
        expectation: `mustNot: ${JSON.stringify({ vendor: 'sgtm', event: '<script>alert(1)</script>', params: { em: HASH, mail: EMAIL }, ids: { 'hashes.em': HASH }, page: EMAIL, 'in': 'epoch(denied)', after: '<script>step()</script>' })}`,
        pass: false,
        evidence: [],
        message: `found ${EMAIL} ${HASH} ${COOKIE} ${AUTH}`,
      },
    ],
    flags: [{ type: 'flag', id: newId('flag'), runId, kind: 'possibleRealData', recordIds: [request.id], detail: `${EMAIL} ${HASH}` }],
    collectorReports: [],
    invalidReports: [],
    ...extra,
  };
}

function leaked(html: string): string[] {
  return [EMAIL, HASH, PHONE, PHONE.replace('+', ''), COOKIE, AUTH, 'secret'].filter((value) => html.includes(value));
}

test('the page holds no value from the records', () => {
  const html = renderReport(buildReportModel(records()));
  expect(leaked(html)).toEqual([]);
  expect(html).toContain('user_data.(other)');
  expect(html).toContain('event_name');
});

test('a scenario rule shows key names, never params, ids or page values', () => {
  const html = renderReport(buildReportModel(records()));
  expect(html).toContain('params.em');
  expect(html).toContain('params.mail');
  expect(html).toContain('ids.hashes.em');
});

test('strings from the records are escaped', () => {
  const html = renderReport(buildReportModel(records()));
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<img');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.yml');
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(html).toContain('&lt;script&gt;step()&lt;/script&gt;');
  expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
});

test('the page makes no request and runs no script', () => {
  const html = renderReport(buildReportModel(records()));
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  expect(CSP).toBe("default-src 'none'; style-src 'unsafe-inline'");
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<link/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toContain('@import');
  expect(html).not.toContain('url(');
  const tags = (html.match(/<[^>]*>/g) ?? []).join('\n');
  expect(tags).not.toMatch(/\b(?:src|href|action|poster|data)=/i);
  expect(tags).not.toMatch(/https?:/i);
  expect(tags).not.toMatch(/\son\w+=/i);
});

test('the sgtm row has a leak mark and the header keeps the host only', () => {
  const html = renderReport(buildReportModel(records()));
  expect(html).toMatch(/<th scope="row">sgtm<\/th>(?:<td class="m-\w+">.*?<\/td>)*?<td class="m-leak">/);
  expect(html).toContain('shop.example.com');
  expect(html).not.toContain('/products/');
});

test('a stub-mode cookie pass shows the caveat, a cannot-evaluate result is not a plain FAIL', () => {
  const results: Result[] = [
    { type: 'result', id: newId('result'), runId, expectation: 'mustNot: {"cookie":"_pwid"}', pass: true, evidence: [], note: 'stubNoCookies' },
    { type: 'result', id: newId('result'), runId, expectation: 'builtin: deniedIdentifiers', pass: false, evidence: [], severity: 'warn', note: 'fieldsNotRecorded' },
  ];
  const html = renderReport(buildReportModel(records({ results })));
  expect(html).toContain('stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies');
  expect(html).toContain('builtin: deniedIdentifiers');
  expect(html).toContain('CANNOT EVALUATE');
  expect(html).toContain('cannot evaluate: field names not recorded');
  expect(html).not.toMatch(/class="s-fail"/);
});

test('a version 1 record says fields were not recorded', () => {
  const base = records();
  const html = renderReport(buildReportModel({ ...base, run: { ...base.run, recordSchemaVersion: 1 } }));
  expect(html).toContain('not recorded (record schema version 1)');
});

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pw-report-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t) } };
};

test('report writes the file from a JSONL record', async () => {
  const data = records();
  const writer = await RunWriter.create(dir, data.run);
  const { run, truncatedAtLine, ...rest } = data;
  void truncatedAtLine;
  for (const record of Object.values(rest).flat() as PingwrightRecord[]) await writer.append(record);
  await writer.close();
  const out = join(dir, 'nested', 'report.html');
  const capture = io();
  expect(await main(['report', writer.path, '--html', out], capture.io)).toBe(0);
  const html = await readFile(out, 'utf8');
  expect(html).toContain('class="m-leak"');
  expect(leaked(html)).toEqual([]);
  expect(run.id).toBe(runId);
});

test('a missing file, a directory and a file that is not a run record exit 2', async () => {
  const bad = join(dir, 'bad.jsonl');
  await writeFile(bad, '{"type":"hit"}\n');
  for (const input of [join(dir, 'nope.jsonl'), dir, bad]) {
    const capture = io();
    expect(await main(['report', input, '--html', join(dir, 'x.html')], capture.io)).toBe(2);
    expect(capture.err.join('')).not.toBe('');
  }
});

test('report needs --html and one file', () => {
  expect(parseCli(['report', 'a.jsonl', '--html', 'out.html'])).toEqual({ command: 'report', input: 'a.jsonl', html: 'out.html' });
  expect(() => parseCli(['report', 'a.jsonl'])).toThrow('--html');
  expect(() => parseCli(['report', '--html', 'o.html'])).toThrow('one JSONL file');
});
