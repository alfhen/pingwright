import { newId, type Flag, type Id } from '@tagreeve/core';

export const MAX_TALLY_KEYS = 256;

export interface TallyArray {
  layer: string;
  a: number | null;
  length: number;
  posted: number;
}

export interface FrameTally {
  frame: number;
  d: string;
  arrays: TallyArray[];
}

/** Counts of the push payloads the binding received, by frame number, document token, layer and array number. */
export class PayloadCounts {
  private readonly counts = new Map<string, number>();
  private overflowed = false;

  static key(frame: number, d: string, layer: string, a: number | null): string {
    return `${frame}\u0000${d}\u0000${layer}\u0000${a ?? ''}`;
  }

  add(payload: { d?: unknown; a?: unknown; layer?: unknown }, frame: number, names: readonly string[]): void {
    const { d, a } = payload;
    const layer = payload.layer === undefined ? 'dataLayer' : payload.layer;
    if (typeof d !== 'string' || d.length > 64 || !Number.isSafeInteger(a) || (a as number) < 0) return;
    if (typeof layer !== 'string' || !names.includes(layer)) return;
    const key = PayloadCounts.key(frame, d, layer, a as number);
    const seen = this.counts.get(key);
    if (seen !== undefined) this.counts.set(key, seen + 1);
    else if (this.counts.size < MAX_TALLY_KEYS) this.counts.set(key, 1);
    else this.overflowed = true;
  }

  /** `undefined` for a key that may have been dropped at the cap. */
  received(frame: number, d: string, layer: string, a: number | null): number | undefined {
    const seen = this.counts.get(PayloadCounts.key(frame, d, layer, a));
    if (seen !== undefined) return seen;
    return this.overflowed ? undefined : 0;
  }
}

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** Keeps only the numbers and hooked names of a page's answer. Anything else is dropped. */
export function validateTally(frame: number, value: unknown, names: readonly string[]): FrameTally | null {
  if (typeof value !== 'object' || value === null) return null;
  const { d, arrays } = value as { d?: unknown; arrays?: unknown };
  if (typeof d !== 'string' || d.length > 64 || !Array.isArray(arrays)) return null;
  const kept: TallyArray[] = [];
  for (const entry of arrays) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { layer, a, length, posted } = entry as Record<string, unknown>;
    if (typeof layer !== 'string' || !names.includes(layer)) continue;
    if (!isCount(length) || !isCount(posted) || !(a === null || isCount(a))) continue;
    kept.push({ layer, a, length, posted });
  }
  return { frame, d, arrays: kept };
}

/** True while the binding has received fewer payloads than a tally says the hook posted. */
export function postedAhead(tallies: readonly FrameTally[], counts: PayloadCounts): boolean {
  return tallies.some((tally) =>
    tally.arrays.some((array) => {
      if (array.a === null) return false;
      const received = counts.received(tally.frame, tally.d, array.layer, array.a);
      return received !== undefined && received < array.posted;
    }),
  );
}

export function buildTallyFlags(runId: Id<'run'>, tallies: readonly FrameTally[], counts: PayloadCounts): Flag[] {
  const flags: Flag[] = [];
  const done = new Set<string>();
  for (const tally of tallies) {
    for (const array of tally.arrays) {
      const received = counts.received(tally.frame, tally.d, array.layer, array.a);
      if (received === undefined || array.length <= received) continue;
      const once = `${tally.frame}\u0000${array.layer}`;
      if (done.has(once)) continue;
      done.add(once);
      flags.push({
        type: 'flag',
        id: newId('flag'),
        runId,
        kind: 'dataLayerIncomplete',
        recordIds: [],
        detail: `Frame ${tally.frame}: ${array.layer} holds ${array.length} items, and ${received} were recorded. A page script may have replaced ${array.layer}.push or the array.`,
      });
    }
  }
  return flags;
}
