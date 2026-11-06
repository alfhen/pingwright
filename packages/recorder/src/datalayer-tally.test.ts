import { newId } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { buildTallyFlags, MAX_TALLY_KEYS, PayloadCounts, postedAhead, validateTally, type FrameTally } from './datalayer-tally.ts';

const NAMES = ['dataLayer', 'myLayer'];
const runId = newId('run');

function counts(frame: number, d: string, layer: string | undefined, a: number, n: number): PayloadCounts {
  const result = new PayloadCounts();
  addTo(result, frame, d, layer, a, n);
  return result;
}

function addTo(target: PayloadCounts, frame: number, d: string, layer: string | undefined, a: number, n: number): void {
  for (let i = 0; i < n; i += 1) target.add({ d, a, ...(layer ? { layer } : {}) }, frame, NAMES);
}

const tally = (frame: number, d: string, arrays: FrameTally['arrays']): FrameTally => ({ frame, d, arrays });

test('equal counts give no flag', () => {
  const tallies = [tally(0, 'tok', [{ layer: 'dataLayer', a: 1, length: 3, posted: 3 }])];
  expect(buildTallyFlags(runId, tallies, counts(0, 'tok', undefined, 1, 3))).toEqual([]);
});

test('a longer array gives one flag with the numbers and no URL', () => {
  const tallies = [tally(2, 'tok', [{ layer: 'dataLayer', a: 1, length: 8, posted: 0 }])];
  const flags = buildTallyFlags(runId, tallies, new PayloadCounts());
  expect(flags).toHaveLength(1);
  expect(flags[0]).toMatchObject({
    type: 'flag',
    kind: 'dataLayerIncomplete',
    recordIds: [],
    detail: 'Frame 2: dataLayer holds 8 items, and 0 were recorded. A page script may have replaced dataLayer.push or the array.',
  });
  expect(flags[0]!.detail).not.toMatch(/https?:/);
});

test('a shorter array gives no flag', () => {
  const tallies = [tally(0, 'tok', [{ layer: 'dataLayer', a: 1, length: 2, posted: 3 }])];
  expect(buildTallyFlags(runId, tallies, counts(0, 'tok', undefined, 1, 3))).toEqual([]);
});

test('two layers and two frames give separate flags', () => {
  const tallies = [
    tally(0, 'a', [
      { layer: 'dataLayer', a: 1, length: 2, posted: 0 },
      { layer: 'myLayer', a: 1, length: 4, posted: 0 },
    ]),
    tally(1, 'b', [{ layer: 'dataLayer', a: 1, length: 5, posted: 0 }]),
  ];
  const details = buildTallyFlags(runId, tallies, new PayloadCounts()).map((f) => f.detail);
  expect(details).toHaveLength(3);
  expect(details[0]).toContain('Frame 0: dataLayer holds 2 items');
  expect(details[1]).toContain('Frame 0: myLayer holds 4 items');
  expect(details[2]).toContain('Frame 1: dataLayer holds 5 items');
});

test('an array the hook never hooked and that holds items gives a flag', () => {
  const tallies = [tally(0, 'tok', [{ layer: 'dataLayer', a: null, length: 1, posted: 0 }])];
  expect(buildTallyFlags(runId, tallies, new PayloadCounts())).toHaveLength(1);
});

test('counts of an older token in the same frame do not change the current token', () => {
  const tallies = [tally(0, 'new', [{ layer: 'dataLayer', a: 1, length: 8, posted: 0 }])];
  const all = new PayloadCounts();
  addTo(all, 0, 'old', undefined, 1, 10);
  expect(buildTallyFlags(runId, tallies, all)).toHaveLength(1);
  addTo(all, 0, 'new', undefined, 1, 3);
  addTo(all, 0, 'old', undefined, 1, 10);
  const [flag] = buildTallyFlags(runId, tallies, all);
  expect(flag!.detail).toContain('holds 8 items, and 3 were recorded');
});

test('another array number of the same token is not counted', () => {
  const tallies = [tally(0, 'tok', [{ layer: 'dataLayer', a: 2, length: 3, posted: 3 }])];
  const all = counts(0, 'tok', undefined, 1, 3);
  expect(buildTallyFlags(runId, tallies, all)).toHaveLength(1);
});

test('validateTally drops a URL or email layer, a string length and a long token', () => {
  const ok = { layer: 'dataLayer', a: 1, length: 2, posted: 2 };
  expect(validateTally(0, { d: 'tok', arrays: [{ ...ok, layer: 'https://planted.example.test/x' }] }, NAMES)?.arrays).toEqual([]);
  expect(validateTally(0, { d: 'tok', arrays: [{ ...ok, layer: 'a@b.test' }] }, NAMES)?.arrays).toEqual([]);
  expect(validateTally(0, { d: 'tok', arrays: [{ ...ok, length: '2' }] }, NAMES)?.arrays).toEqual([]);
  expect(validateTally(0, { d: 'tok', arrays: [{ ...ok, a: -1 }] }, NAMES)?.arrays).toEqual([]);
  expect(validateTally(0, { d: 'x'.repeat(65), arrays: [ok] }, NAMES)).toBeNull();
  expect(validateTally(0, null, NAMES)).toBeNull();
  expect(validateTally(0, { d: 'tok', arrays: [ok, { ...ok, a: null }] }, NAMES)?.arrays).toHaveLength(2);
});

test('PayloadCounts ignores a payload with a bad token, array number or layer', () => {
  const all = new PayloadCounts();
  all.add({ d: 5, a: 1 }, 0, NAMES);
  all.add({ d: 'x'.repeat(65), a: 1 }, 0, NAMES);
  all.add({ d: 'tok', a: 1.5 }, 0, NAMES);
  all.add({ d: 'tok', a: 1, layer: 'other' }, 0, NAMES);
  all.add({ a: 1 }, 0, NAMES);
  expect(all.received(0, 'tok', 'dataLayer', 1)).toBe(0);
});

test('a capped key gives no flag and a counted key still compares', () => {
  const all = new PayloadCounts();
  for (let i = 0; i < MAX_TALLY_KEYS; i += 1) addTo(all, i, 'tok', undefined, 1, 1);
  addTo(all, 999, 'tok', undefined, 1, 4);
  const tallies = [
    tally(999, 'tok', [{ layer: 'dataLayer', a: 1, length: 4, posted: 4 }]),
    tally(3, 'tok', [{ layer: 'dataLayer', a: 1, length: 4, posted: 4 }]),
  ];
  const flags = buildTallyFlags(runId, tallies, all);
  expect(flags).toHaveLength(1);
  expect(flags[0]!.detail).toContain('Frame 3:');
  expect(postedAhead([tallies[0]!], all)).toBe(false);
});

test('a document that lost no key at the cap still gets a flag', () => {
  const all = new PayloadCounts();
  for (let i = 0; i < MAX_TALLY_KEYS; i += 1) addTo(all, i, 'tok', undefined, 1, 1);
  addTo(all, 999, 'tok', undefined, 1, 1);
  const flags = buildTallyFlags(runId, [tally(500, 'tok', [{ layer: 'dataLayer', a: 1, length: 8, posted: 0 }])], all);
  expect(flags).toHaveLength(1);
  const unhooked = buildTallyFlags(runId, [tally(501, 'tok', [{ layer: 'dataLayer', a: null, length: 3, posted: 0 }])], all);
  expect(unhooked).toHaveLength(1);
});

test('postedAhead is true while fewer payloads arrived than the hook posted', () => {
  const tallies = [tally(0, 'tok', [{ layer: 'dataLayer', a: 1, length: 3, posted: 3 }])];
  const all = counts(0, 'tok', undefined, 1, 2);
  expect(postedAhead(tallies, all)).toBe(true);
  addTo(all, 0, 'tok', undefined, 1, 1);
  expect(postedAhead(tallies, all)).toBe(false);
  expect(postedAhead([tally(0, 'tok', [{ layer: 'dataLayer', a: null, length: 3, posted: 0 }])], new PayloadCounts())).toBe(false);
});
