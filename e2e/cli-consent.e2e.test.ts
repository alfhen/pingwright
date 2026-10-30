import { expect, test } from 'vitest';
import { RECORD_SCHEMA_VERSION } from '../packages/core/src/index.ts';
import { ga4, outDir, run, runCli, SANDBOX, scenario, site } from './cli-helpers.ts';

test('undecided: hits per vendor, denied consent, flags, one epoch', async () => {
  const r = await run('undecided');
  expect(r.code).toBe(1);
  expect(r.failed).toEqual([SANDBOX]);
  const { hits, consentEpochs, flags, results } = r.records!;
  expect(results.length).toBeGreaterThan(0);
  expect(r.records!.run.recordSchemaVersion).toBe(RECORD_SCHEMA_VERSION);
  expect(consentEpochs.map((e) => e.label)).toEqual(['undecided']);
  const ownConsent = ga4(hits, 'page_view').filter((h) => 'gcs' in h.consent.raw);
  expect(ownConsent.length).toBeGreaterThan(0);
  expect(ownConsent.every((h) => h.consent.analytics === 'denied')).toBe(true);
  expect(hits.some((h) => h.vendor === 'sgtm')).toBe(true);
  expect(hits.some((h) => h.vendor === 'meta' && h.event === 'PageView')).toBe(true);
  const stapeUrls = new Set(r.records!.requests.filter((q) => q.url.startsWith(`${site.sgtmUrl}/pwstape?`)).map((q) => q.id));
  expect(hits.some((h) => h.vendor === 'ga4' && stapeUrls.has(h.requestId))).toBe(true);
  expect(hits.some((h) => h.vendor === 'sgtm' && stapeUrls.has(h.requestId))).toBe(true);
  expect(flags.some((f) => f.kind === 'unknownDestination')).toBe(true);
  expect(flags.some((f) => f.kind === 'sandboxPageUrl')).toBe(true);
  expect(r.records!.requests.some((q) => q.outcome === 'stubbed')).toBe(true);
}, 90_000);

test('accept: granted epoch, add_to_cart granted', async () => {
  const r = await run('accept');
  expect(r.failed).toEqual([SANDBOX]);
  const { hits, consentEpochs } = r.records!;
  expect(consentEpochs.map((e) => e.label)).toEqual(['undecided', 'granted']);
  const atc = ga4(hits, 'add_to_cart');
  expect(atc.length).toBeGreaterThan(0);
  expect(atc.every((h) => h.consent.analytics === 'granted')).toBe(true);
  expect(hits.some((h) => h.vendor === 'meta' && h.event === 'AddToCart')).toBe(true);
}, 90_000);

test('reject: denied epoch, add_to_cart denied', async () => {
  const r = await run('reject');
  expect(r.failed).toEqual([SANDBOX]);
  expect(r.records!.consentEpochs.map((e) => e.label)).toEqual(['undecided', 'denied']);
  const atc = ga4(r.records!.hits, 'add_to_cart');
  expect(atc.length).toBeGreaterThan(0);
  expect(atc.every((h) => h.consent.analytics === 'denied')).toBe(true);
}, 90_000);

test('accept then withdraw: three epochs, add_to_cart denied', async () => {
  const r = await run('accept-then-withdraw');
  expect(r.failed).toEqual([SANDBOX]);
  expect(r.records!.consentEpochs.map((e) => e.label)).toEqual(['undecided', 'granted', 'withdrawn']);
  expect(r.records!.consentEpochs.at(-1)!.state.analytics).toBe('denied');
  const atc = ga4(r.records!.hits, 'add_to_cart');
  expect(atc.length).toBeGreaterThan(0);
  expect(atc.every((h) => h.consent.analytics === 'denied')).toBe(true);
}, 90_000);

test('a Meta hit after a withdrawal fails epoch(label=withdrawn) and epoch(denied)', async () => {
  for (const name of ['meta-after-withdrawn-label', 'meta-after-withdrawn-state']) {
    const r = await run(name);
    expect(r.code).toBe(1);
    const rule = r.records!.results.find((x) => x.expectation.startsWith('mustNot:'))!;
    expect(rule.pass).toBe(false);
    const meta = r.records!.hits.filter((h) => h.vendor === 'meta' && h.event === 'AddToCart');
    expect(meta.length).toBeGreaterThan(0);
    expect(rule.evidence).toEqual(expect.arrayContaining(meta.map((h) => h.id)));
  }
}, 180_000);

test('after a reject only, epoch(label=withdrawn) matches nothing', async () => {
  const r = await run('meta-reject-withdrawn-label');
  const rule = r.records!.results.find((x) => x.expectation.startsWith('mustNot:'))!;
  expect(rule.pass).toBe(true);
  const epochs = r.records!.consentEpochs;
  expect(epochs.map((e) => e.label)).toEqual(['undecided', 'denied']);
  const addToCart = r.records!.hits.filter((h) => h.vendor === 'meta' && h.event === 'AddToCart');
  expect(addToCart.length).toBeGreaterThan(0);
  expect(addToCart.every((h) => h.t >= epochs[1]!.startT)).toBe(true);
}, 90_000);

test('banner not shown: a HeadlessChrome user agent exits 2', async () => {
  const ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';
  const r = await run('banner-not-shown', [], { PINGWRIGHT_TEST_USER_AGENT: ua });
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('banner not shown');
  expect(r.stderr).toContain('Record:');
}, 90_000);

test('banner not shown: the same scenario with the normal user agent gets past the consent step', async () => {
  const r = await run('banner-not-shown');
  expect(r.code).toBe(1);
  expect(r.failed).toEqual([SANDBOX]);
}, 90_000);

test('a mustNot meta before consent rule fails on the fixture pixel', async () => {
  const r = await run('meta-before-consent');
  expect(r.code).toBe(1);
  expect(r.failed).toContain('mustNot: {"vendor":"meta","before":"consent"}');
}, 90_000);

test('text summary names a Pinterest /user/ hit without an event', async () => {
  const r = await runCli(['run', scenario('pinterest-user'), '--site', site.url, '--out', outDir]);
  expect(r.stdout).toMatch(/pinterest: .*\buser x1\b/);
  expect(r.stdout).toContain('PASS must: {"vendor":"pinterest","event":"user"}');
  expect(r.stdout).not.toContain('(no event)');
}, 90_000);

test('text summary rounds epoch durations', async () => {
  const r = await runCli(['run', scenario('accept'), '--site', site.url, '--out', outDir]);
  expect(r.stdout).toMatch(/\n {2}undecided \(\d+(\.\d)? (s|ms)\)\n/);
  expect(r.stdout).not.toMatch(/\d+\.\d{2,} ?(ms|s)\)/);
}, 90_000);

test('builtins: sandboxPageUrl warn keeps the warning and exits 0, and without it the run exits 1', async () => {
  const warned = await run('undecided-warn');
  expect(warned.code).toBe(0);
  const summary = JSON.parse(warned.stdout) as { pass: boolean; ok: boolean; results: { expectation: string; pass: boolean; severity?: string }[] };
  expect(summary.pass).toBe(false);
  expect(summary.ok).toBe(true);
  expect(summary.results.find((r) => r.expectation === SANDBOX)).toMatchObject({ pass: false, severity: 'warn' });
  const stored = warned.records!.results.find((r) => r.expectation === SANDBOX)!;
  expect(stored).toMatchObject({ pass: false, severity: 'warn' });
  expect(stored.evidence.length).toBeGreaterThan(0);

  const text = await runCli(['run', scenario('undecided-warn'), '--site', site.url, '--out', outDir]);
  expect(text.code).toBe(0);
  expect(text.stdout).toMatch(/WARN builtin: sandboxPageUrl/);
  expect(text.stdout).toContain('Result: pass with 1 warning');

  const strict = await run('undecided');
  expect(strict.code).toBe(1);
}, 180_000);
