import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

const mustRule = (results: { expectation: string; pass: boolean }[]) => results.find((r) => r.expectation.startsWith('must:'))!;

test('--net-log records the beacon and the keepalive POST a sandboxed frame sends on unload', async () => {
  const { records, code } = await run('unload-beacons', ['--net-log']);
  expect(code).toBeLessThanOrEqual(1);
  const late = records!.requests.filter((r) => r.captured === 'netlog');
  expect(late.map((r) => new URL(r.url).searchParams.get('ep.via')).sort()).toEqual(['beacon', 'keepalive']);
  expect(late.every((r) => r.method === 'POST' && r.initiator === 'unload')).toBe(true);
  const hits = records!.hits.filter((h) => h.vendor === 'ga4' && h.event === 'add_to_cart');
  expect(hits.map((h) => h.requestId).sort()).toEqual(late.map((r) => r.id).sort());
  expect(hits.every((h) => h.consent.analytics === 'denied')).toBe(true);
  expect(mustRule(records!.results).pass).toBe(true);
  expect(records!.flags.filter((f) => f.kind === 'stubBypass')).toHaveLength(2);
  expect(records!.flags.some((f) => f.kind === 'unloadGap')).toBe(false);
}, 90_000);

test('without --net-log the missing hit is reported as a gap in the summary', async () => {
  const { records } = await run('unload-beacons');
  expect(records!.requests.some((r) => r.captured === 'netlog')).toBe(false);
  expect(records!.hits.some((h) => h.event === 'add_to_cart')).toBe(false);
  expect(mustRule(records!.results).pass).toBe(false);
  const gap = records!.flags.filter((f) => f.kind === 'unloadGap');
  expect(gap).toHaveLength(1);
  expect(gap[0]!.detail).toContain('add_to_cart');
  expect(gap[0]!.detail).toContain('--net-log');
}, 90_000);
