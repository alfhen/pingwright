import type { DiffResult } from '@pingwright/expect';
import { expect, test } from 'vitest';
import { formatDiff } from './diff.ts';

const empty: DiffResult = { warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags: [] };

test('labels a count mismatch under its event', () => {
  const key = { epoch: 'undecided', vendor: 'ga4', event: 'page_view' };
  const text = formatDiff(
    { ...empty, removed: [{ key, hitId: 'hit_2', t: 1, step: '', page: null }], countMismatches: [{ key, a: 2, b: 1 }] },
    'a.jsonl',
    'b.jsonl',
  );
  expect(text).toContain('      removed: hit_2\n      count 2 -> 1 (pairing by order)\n');
});
