import { IDENTIFIER_LEAK, type ReportModel } from './model.ts';

export interface Findings {
  /** Vendors that sent hits in a state, and vendors whose identifiers went out in a state. Keyed by epoch label. */
  hits: Map<string, Set<string>>;
  identifiers: Map<string, Set<string>>;
  failed: number;
  warned: number;
  unchecked: number;
}

export function emptyFindings(): Findings {
  return { hits: new Map(), identifiers: new Map(), failed: 0, warned: 0, unchecked: 0 };
}

export function addFindings(into: Findings, model: ReportModel): void {
  for (const row of model.rows) {
    row.segments.forEach((segment, i) => {
      if (segment.mark !== 'leak') return;
      const target = segment.label === IDENTIFIER_LEAK ? into.identifiers : into.hits;
      const label = model.columns[i]!.label;
      const vendors = target.get(label) ?? new Set<string>();
      vendors.add(row.vendor);
      target.set(label, vendors);
    });
  }
  for (const e of model.expectations) {
    if (e.status === 'FAIL') into.failed++;
    else if (e.status === 'WARN') into.warned++;
    else if (e.status === 'CANNOT EVALUATE') into.unchecked++;
  }
}

function list(names: Iterable<string>): string {
  const all = [...names].sort();
  return all.length < 2 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Built from marks and counts only: vendor names, epoch labels and numbers, never a value. */
export function findingsSentence(f: Findings): string {
  const parts: string[] = [];
  for (const [label, vendors] of [...f.hits].sort(([a], [b]) => a.localeCompare(b))) parts.push(`${list(vendors)} send hits in the ${label} state`);
  for (const [label, vendors] of [...f.identifiers].sort(([a], [b]) => a.localeCompare(b))) parts.push(`identifiers go out to ${list(vendors)} in the ${label} state`);
  if (parts.length === 0 && f.unchecked === 0) parts.push('no leaks');
  if (f.failed > 0) parts.push(plural(f.failed, 'failed expectation'));
  if (f.unchecked > 0) parts.push(`${plural(f.unchecked, 'expectation')} could not be checked`);
  if (f.warned > 0) parts.push(plural(f.warned, 'accepted warning'));
  return parts.join(', ');
}

export function runVerdict(model: ReportModel): string {
  const findings = emptyFindings();
  addFindings(findings, model);
  return `Verdict: ${findingsSentence(findings)}.`;
}
