import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

test('a frame push shortly before the run ends is reported as an unload gap', async () => {
  const { records } = await run('unload-gap-close');
  expect(records!.hits.some((h) => h.event === 'add_to_cart')).toBe(false);
  const gaps = records!.flags.filter((f) => f.kind === 'unloadGap');
  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.detail).toContain('"add_to_cart"');
  expect(gaps[0]!.detail).toContain('before the run ended');
}, 90_000);

test('a custom event covered by a GA4 hit from the same frame is not reported', async () => {
  const { records } = await run('unload-gap-custom');
  expect(records!.hits.some((h) => h.vendor === 'sgtm' && h.event === 'custom_add')).toBe(true);
  expect(records!.dataLayerEvents.some((e) => e.event === 'custom_add')).toBe(true);
  const ga4 = records!.hits.find((h) => h.vendor === 'ga4' && h.event === 'custom_add_ga');
  expect(ga4).toBeDefined();
  const request = records!.requests.find((r) => r.id === ga4!.requestId);
  expect(request!.frameUrl).toContain('/web-pixels@0.0.0-fixture/sandbox/gap/');
  expect(records!.flags.filter((f) => f.kind === 'unloadGap')).toEqual([]);
}, 90_000);

test('a checkout_completed push from a srcdoc frame shortly before the run ends is reported', async () => {
  const { records } = await run('unload-gap-checkout');
  expect(records!.dataLayerEvents.some((e) => e.event === 'checkout_completed')).toBe(true);
  expect(records!.hits.some((h) => h.vendor === 'sgtm' && h.event === 'checkout_completed')).toBe(true);
  expect(records!.hits.some((h) => h.vendor === 'ga4' && h.event === 'page_view')).toBe(true);
  expect(records!.hits.some((h) => h.vendor === 'ga4' && h.event === 'purchase')).toBe(false);
  const gaps = records!.flags.filter((f) => f.kind === 'unloadGap');
  expect(gaps).toHaveLength(1);
  expect(gaps[0]!.detail).toContain('"checkout_completed"');
  expect(gaps[0]!.detail).toContain('before the run ended');
}, 90_000);
