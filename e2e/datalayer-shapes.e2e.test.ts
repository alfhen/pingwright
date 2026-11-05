import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

interface Shape {
  event: string;
  frame: string;
  count: number;
  paths: { path: string; types: string[] }[];
  ids: string[];
}

interface Summary {
  dataLayer?: { pushes: number; steps: { step: string; events: Shape[] }[] };
}

const LEAKS = [/fake\.person/, /example\.test/, /gid:\/\//, /1234567890/, /deadbeef/, /pw-secret-value/, /tok-value/];

test('the summary carries masked push shapes and no pushed value', async () => {
  const r = await run('datalayer-shapes');
  const records = r.records!;
  const args = JSON.stringify(records.dataLayerEvents.map((e) => e.args));
  expect(args).toContain('fake.person@example.test');
  expect(args).toContain('gid://shopify/Product/1234567890');
  expect(args).toContain('deadbeefdeadbeefdeadbeefdeadbeef');
  expect(records.dataLayerEvents.some((e) => e.event === 'fake.person@example.test')).toBe(true);
  expect(records.dataLayerEvents.some((e) => e.frame?.main === false)).toBe(true);

  const { dataLayer } = JSON.parse(r.stdout) as Summary;
  expect(dataLayer).toBeDefined();
  expect(dataLayer!.pushes).toBe(records.dataLayerEvents.length);
  const events = dataLayer!.steps.flatMap((s) => s.events);

  const purchase = events.find((e) => e.event === 'purchase' && e.frame === 'main')!;
  const paths = purchase.paths.map((p) => p.path);
  expect(paths).toContain('ecommerce.items[*].item_id');
  expect(paths).toContain('ecommerce.value');
  expect(paths).toContain('extra.(other)');
  expect(paths.some((p) => /\[\d+\]/.test(p))).toBe(false);
  expect(purchase.ids).toHaveLength(1);

  expect(events.some((e) => e.event === '(other)' && e.frame === 'main')).toBe(true);
  const consent = events.find((e) => e.event === 'consent default')!;
  expect(consent.paths.map((p) => p.path)).toEqual(['ad_storage', 'analytics_storage']);
  const embedded = events.find((e) => e.event === 'embedded_push' && e.frame === 'embedded')!;
  expect(embedded.paths.map((p) => p.path)).toEqual(['event', 'checkout.(other)']);

  for (const leak of LEAKS) {
    expect(r.stdout).not.toMatch(leak);
    expect(r.stderr).not.toMatch(leak);
  }
}, 150_000);

test('the text summary has one dataLayer line and no shapes', async () => {
  const r = await runText('datalayer-shapes');
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('dataLayer:'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/^dataLayer: \d+ pushes, \d+ events \(.*\); shapes in --json$/);
  for (const leak of LEAKS) {
    expect(r.stdout).not.toMatch(leak);
    expect(r.stderr).not.toMatch(leak);
  }
}, 150_000);
