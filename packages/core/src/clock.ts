/** Epoch milliseconds. The page clock is performance.timeOrigin + performance.now(); Node uses Date.now(). */
export type EpochMs = number;

export function nodeNow(): EpochMs {
  return Date.now();
}

/** Source of the page clock, to be evaluated in the page. */
export const pageNowExpression = 'performance.timeOrigin + performance.now()';

/** Offset to add to this page's times, from a Node reading and a page reading taken together. */
export function measurePageOffset(nodeTime: EpochMs, pageTime: EpochMs): number {
  return nodeTime - pageTime;
}

/** Measures the offset over several samples and keeps the one with the shortest round trip. */
export function bestPageOffset(
  samples: readonly { before: EpochMs; page: EpochMs; after: EpochMs }[],
): number {
  let best: { rtt: number; offset: number } | undefined;
  for (const s of samples) {
    const rtt = s.after - s.before;
    const offset = measurePageOffset(s.before + rtt / 2, s.page);
    if (!best || rtt < best.rtt) best = { rtt, offset };
  }
  if (!best) throw new Error('bestPageOffset needs at least one sample');
  return best.offset;
}

export function pageTimeToEpoch(pageTime: EpochMs, offset: number): EpochMs {
  return pageTime + offset;
}
