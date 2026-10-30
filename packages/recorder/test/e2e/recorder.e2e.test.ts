import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRun, type Hit, type Request, type RunRecords } from '@pingwright/core';
import { isCollectionEndpoint, isSandboxPageUrl } from '@pingwright/decoders';
import { startFixtureSite, type FixtureSite } from '@pingwright/fixture-site';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { launchRecorder, recordVisit, type RunResult } from '../../src/index.ts';

let site: FixtureSite;
let outDir: string;
let result: RunResult;
let records: RunRecords;

beforeAll(async () => {
  site = await startFixtureSite();
  const parent = fileURLToPath(new URL('../../../../test-results/', import.meta.url));
  await mkdir(parent, { recursive: true });
  outDir = await mkdtemp(join(parent, 'recorder-'));
  result = await recordVisit({
    networkMode: 'stub',
    outDir,
    site: site.url,
    startUrl: `${site.url}/`,
    waitMs: 6000,
    graceWindowMs: 120,
  });
  records = result.records;
});

afterAll(async () => {
  await site?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

const url = (r: Request) => new URL(r.url);
const isMetaTr = (r: Request) => /(^|\.)facebook\.com$/.test(url(r).hostname) && /^\/tr\/?$/.test(url(r).pathname);
const isAdsCollect = (r: Request) =>
  /(^|\.)(googleadservices|doubleclick|googlesyndication)\.com$|^(www\.)?google\.com$/.test(url(r).hostname) &&
  /^\/(ccm\/collect|pagead\/)/.test(url(r).pathname);
const isTagManagerPing = (r: Request) => /(^|\.)googletagmanager\.com$/.test(url(r).hostname) && /^\/(a|td)\/?$/.test(url(r).pathname);

describe('record schema version 2', () => {
  test('the run holds the version and the grace window', () => {
    expect(records.run.recordSchemaVersion).toBe(2);
    expect(records.run.graceWindowMs).toBe(120);
  });

  test('every decoded hit has field names, and a GA4 hit has its query names', () => {
    expect(records.hits.length).toBeGreaterThan(0);
    for (const hit of records.hits) {
      expect(Array.isArray(hit.fields)).toBe(true);
      expect(Array.isArray(hit.idFields)).toBe(true);
      expect(hit.fieldsComplete).toBe(true);
    }
    const ga4 = records.hits.find((h) => h.vendor === 'ga4')!;
    expect(ga4.fields).toEqual(expect.arrayContaining(['tid', 'v']));
  });
});

describe('stub mode on the fixture site', () => {
  test('no collection request is passed through', () => {
    const collection = records.requests.filter((r) => isCollectionEndpoint(r));
    expect(collection.length).toBeGreaterThanOrEqual(2);
    expect(collection.filter((r) => r.outcome === 'passed')).toEqual([]);
  });

  test('no request to a known vendor collection path is passed or failed', () => {
    const vendor = records.requests.filter((r) => isCollectionEndpoint(r) || isMetaTr(r) || isAdsCollect(r) || isTagManagerPing(r));
    expect(vendor.filter((r) => r.outcome === 'passed' || r.outcome === 'failed')).toEqual([]);
  });

  test('GA4 collection requests are stubbed and answered locally', () => {
    const ga4 = records.requests.filter((r) => url(r).pathname === '/g/collect' && url(r).hostname.endsWith('google-analytics.com'));
    expect(ga4.length).toBeGreaterThanOrEqual(2);
    expect(ga4.every((r) => r.outcome === 'stubbed')).toBe(true);
    const responses = records.responses.filter((res) => ga4.some((r) => r.id === res.requestId));
    expect(responses.length).toBeGreaterThan(0);
    expect(responses.every((res) => res.status === 204)).toBe(true);
  });

  test('Meta and Ads collection requests are not passed through', () => {
    const meta = records.requests.filter(isMetaTr);
    const ads = records.requests.filter(isAdsCollect);
    expect(meta.length).toBeGreaterThan(0);
    expect(ads.length).toBeGreaterThan(0);
    expect(meta.filter((r) => r.outcome !== 'stubbed')).toEqual([]);
    expect(ads.filter((r) => r.outcome !== 'stubbed')).toEqual([]);
  });

  test('scripts and pages load normally', () => {
    const scripts = records.requests.filter((r) => r.resourceType === 'script');
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.every((r) => r.outcome === 'passed')).toBe(true);
  });

  test('the unknown destination is flagged', () => {
    const flagged = records.flags
      .filter((f) => f.kind === 'unknownDestination')
      .flatMap((f) => f.recordIds)
      .map((id) => records.requests.find((r) => r.id === id));
    expect(flagged.map((r) => r?.url)).toContain(`${site.thirdPartyUrl}/unknown-pixel?x=1`);
  });

  test('the fixture pixel report is recorded and nothing is invalid', () => {
    expect(records.collectorReports.map((r) => r.source)).toContain('fixture-pixel');
    expect(records.invalidReports).toEqual([]);
    expect(records.requests.filter((r) => r.url.includes('collector.pingwright.invalid'))).toEqual([]);
  });

  test('capture coverage lists page, iframe and worker', () => {
    expect(records.run.coverage).toEqual({
      page: true,
      iframe: true,
      dedicatedWorker: true,
      serviceWorker: 'chromium-only',
    });
    expect(records.collectorReports.filter((r) => r.source.startsWith('selftest:'))).toEqual([]);
  });

  test('a GA4 hit from the sandbox iframe gets a sandboxPageUrl flag', () => {
    const sandboxHit = records.hits.find((h: Hit) => h.vendor === 'ga4' && isSandboxPageUrl(h.page));
    expect(sandboxHit).toBeDefined();
    const flag = records.flags.find((f) => f.kind === 'sandboxPageUrl' && f.recordIds.includes(sandboxHit!.id));
    expect(flag).toBeDefined();
    const pageHit = records.hits.find((h) => h.vendor === 'ga4' && !isSandboxPageUrl(h.page));
    expect(pageHit).toBeDefined();
  });

  test('requests carry frames, a normal user agent and the shared clock', () => {
    const start = records.run.startedAt;
    expect(records.requests.every((r) => r.t >= start - 1000 && r.t <= Date.now())).toBe(true);
    const gtag = records.requests.find((r) => r.url.startsWith('https://www.googletagmanager.com/gtag/js'));
    expect(gtag?.frameUrl).toBe(`${site.url}/`);
    const document = records.requests.find((r) => r.resourceType === 'document' && r.url === `${site.url}/`);
    expect(document?.headers['user-agent']).toMatch(/Chrome\/\d+/);
    expect(document?.headers['user-agent']).not.toContain('HeadlessChrome');
  });

  test('dataLayer pushes are recorded, with the Consent Mode default as a consent command', () => {
    const consent = records.dataLayerEvents.find((e) => e.isConsentCommand);
    expect(consent?.args.slice(0, 2)).toEqual(['consent', 'default']);
    expect(consent?.args[2]).toMatchObject({ ad_storage: 'denied', analytics_storage: 'denied' });
    expect(records.dataLayerEvents.some((e) => e.event === 'gtm.dom')).toBe(true);
    expect(records.dataLayerEvents.every((e) => e.t >= records.run.startedAt - 1000)).toBe(true);
  });

  test('the JSONL file round-trips', async () => {
    const text = await readFile(result.path, 'utf8');
    const lines = text.trim().split('\n');
    const total = Object.entries(records).reduce((n, [key, value]) => n + (key === 'run' ? 1 : (value as unknown[]).length), 0);
    expect(lines).toHaveLength(total);
    expect(JSON.parse(lines[0]!)).toMatchObject({ type: 'run', id: records.run.id });
    const parsed = lines.map((line) => JSON.parse(line) as { id: string });
    const inMemory = [records.run, ...Object.values(records).filter(Array.isArray).flat()] as { id: string }[];
    expect(parsed.map((r) => r.id).sort()).toEqual(inMemory.map((r) => r.id).sort());
    for (const record of inMemory) expect(parsed.find((r) => r.id === record.id)).toEqual(JSON.parse(JSON.stringify(record)));
    expect(await readRun(result.path)).toEqual(records);
    expect(result.path).toBe(join(outDir, `${records.run.id}.jsonl`));
  });
});

test('a site report with a selftest: source is stored, because the self-test prefix is private to the launch', async () => {
  const recorder = await launchRecorder({ networkMode: 'stub', outDir, site: site.url });
  const page = await recorder.visit(`${site.url}/`);
  await page.evaluate(() =>
    navigator.sendBeacon('https://collector.pingwright.invalid/report', JSON.stringify({ source: 'selftest:page' })),
  );
  await recorder.wait(500);
  const { records: late } = await recorder.close();
  expect(late.collectorReports.map((r) => r.source)).toContain('selftest:page');
});
