import { expect, test } from 'vitest';
import { ga4, run, SANDBOX, site } from './cli-helpers.ts';

test('undecided: hits per vendor, denied consent, flags, one epoch', async () => {
  const r = await run('undecided');
  expect(r.code).toBe(1);
  expect(r.failed).toEqual([SANDBOX]);
  const { hits, consentEpochs, flags, results } = r.records!;
  expect(results.length).toBeGreaterThan(0);
  expect(r.records!.run.recordSchemaVersion).toBe(1);
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
  expect(r.records!.hits.some((h) => h.vendor === 'meta')).toBe(true);
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
