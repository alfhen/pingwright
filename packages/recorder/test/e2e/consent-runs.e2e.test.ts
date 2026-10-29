import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { epochForHit, parseScenario, placeHitsInEpochs } from '@pingwright/expect';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { recordScenario, StepError } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'consent-runs-'));
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const run = (yaml: string) =>
  recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed: parseScenario(yaml) }).then((r) => r.records);

const googleOwn = (h: { vendor: string; consent: { raw: Record<string, string> } }) => h.vendor === 'ga4' && 'gcs' in h.consent.raw;

const states = (epochs: { label: string }[]) => epochs.map((e) => e.label);

test('undecided: one undecided epoch, GA4 hits carry analytics denied', async () => {
  const records = await run('start: /products/fake-tee\nsteps:\n  - consent: none\n  - wait: 3s\n');
  expect(records.consentEpochs).toHaveLength(1);
  expect(records.consentEpochs[0]).toMatchObject({ label: 'undecided', state: { analytics: 'denied' }, source: 'start', endT: null });
  const ga4 = records.hits.filter(googleOwn);
  expect(ga4.length).toBeGreaterThan(0);
  expect(ga4.every((h) => h.consent.analytics === 'denied')).toBe(true);
});

test('accept: two epochs, GA4 hits after accept granted, Meta hits in the granted epoch', async () => {
  const records = await run(
    'start: /products/fake-tee\nsteps:\n  - consent: accept\n  - addToCart: "#add-to-cart"\n  - wait: 8s\n',
  );
  const epochs = records.consentEpochs;
  expect(states(epochs)).toEqual(['undecided', 'granted']);
  const granted = epochs[1]!;
  const ga4 = records.hits.filter((h) => googleOwn(h) && h.event === 'add_to_cart');
  expect(ga4.length).toBeGreaterThan(0);
  expect(ga4.every((h) => h.t >= granted.startT && h.consent.analytics === 'granted')).toBe(true);
  const meta = [...placeHitsInEpochs(records.hits.filter((h) => h.vendor === 'meta' && h.event === 'AddToCart'), epochs)];
  expect(meta.length).toBeGreaterThan(0);
  expect(meta.every(([, epoch]) => epoch === granted)).toBe(true);
});

test('reject: GA4 hits after reject are denied', async () => {
  const records = await run(
    'start: /products/fake-tee\nsteps:\n  - consent: reject\n  - addToCart: "#add-to-cart"\n  - wait: 8s\n',
  );
  expect(states(records.consentEpochs)).toEqual(['undecided', 'denied']);
  const denied = records.consentEpochs[1]!;
  const ga4 = records.hits.filter((h) => googleOwn(h) && h.event === 'add_to_cart' && h.t >= denied.startT);
  expect(ga4.length).toBeGreaterThan(0);
  expect(ga4.every((h) => h.consent.analytics === 'denied')).toBe(true);
});

test('accept then withdraw: three epochs, hits after withdraw are denied', async () => {
  const records = await run(
    [
      'start: /products/fake-tee',
      'steps:',
      '  - consent: accept',
      '  - wait: 1s',
      '  - click: "#pw-cookie-settings"',
      '  - consent: reject',
      '  - addToCart: "#add-to-cart"',
      '  - wait: 8s',
    ].join('\n'),
  );
  expect(states(records.consentEpochs)).toEqual(['undecided', 'granted', 'denied']);
  const withdrawn = records.consentEpochs[2]!;
  const ga4 = records.hits.filter((h) => googleOwn(h) && h.event === 'add_to_cart' && h.t >= withdrawn.startT);
  expect(ga4.length).toBeGreaterThan(0);
  expect(ga4.every((h) => h.consent.analytics === 'denied')).toBe(true);
  const meta = records.hits.find((h) => h.vendor === 'meta' && h.event === 'AddToCart');
  expect(meta).toBeDefined();
  expect(epochForHit(records.consentEpochs, meta!.t)).toBe(withdrawn);
});

test('banner not shown: a HeadlessChrome user agent fails consent: none', async () => {
  const parsed = parseScenario('start: /\noptions: { consentTimeout: 2s }\nsteps:\n  - consent: none\n');
  const userAgentOverride =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.0.0 Safari/537.36';
  const error = await recordScenario({ networkMode: 'stub', outDir, site: site.url, parsed, userAgentOverride }).catch(
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StepError);
  expect((error as StepError).message).toContain('banner not shown');
  const records = (error as StepError).run!.records;
  expect(records.steps.find((s) => s.label === 'consent-1')?.error).toBe('banner not shown');
});
