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
  expect(records!.flags.filter((f) => f.kind === 'unloadGap')).toEqual([]);
}, 90_000);
