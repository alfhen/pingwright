import { IDENTIFIER_LEAK, type ReportModel } from './model.ts';
import { byVendorName, vendorName } from './names.ts';

export interface Findings {
  /** Vendors that sent hits in a state, and vendors whose identifiers went out in a state. Keyed by epoch label. */
  hits: Map<string, Set<string>>;
  identifiers: Map<string, Set<string>>;
  /** Failed and warned rules: `must`, `mustNot` and unreadable entries. */
  failed: number;
  warned: number;
  /** Built-in checks that failed or warned, with the number of runs each did so in. */
  failedChecks: Map<string, number>;
  warnedChecks: Map<string, number>;
  unchecked: number;
}

export function emptyFindings(): Findings {
  return { hits: new Map(), identifiers: new Map(), failed: 0, warned: 0, failedChecks: new Map(), warnedChecks: new Map(), unchecked: 0 };
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
  const failedHere = new Set<string>();
  const warnedHere = new Set<string>();
  for (const e of model.expectations) {
    if (e.status === 'CANNOT EVALUATE') into.unchecked++;
    else if (e.status === 'FAIL' || e.status === 'WARN') {
      const failing = e.status === 'FAIL';
      if (e.kind === 'builtin') (failing ? failedHere : warnedHere).add(e.text.replace(/^builtin: /, ''));
      else if (failing) into.failed++;
      else into.warned++;
    }
  }
  for (const name of failedHere) into.failedChecks.set(name, (into.failedChecks.get(name) ?? 0) + 1);
  for (const name of warnedHere) into.warnedChecks.set(name, (into.warnedChecks.get(name) ?? 0) + 1);
}

function list(names: Iterable<string>): string {
  const all = [...names].sort(byVendorName).map(vendorName);
  return all.length < 2 ? all.join('') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function checkParts(checks: Map<string, number>, verb: string, inRuns: boolean): string[] {
  return [...checks]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, runs]) => `built-in check ${name} ${verb}${inRuns ? ` in ${plural(runs, 'run')}` : ''}`);
}

/**
 * Built from marks and counts only: vendor names, epoch labels, check names and numbers, never a value.
 * `inRuns` adds the run count to a built-in check, for a verdict that covers several runs.
 */
export function findingsSentence(f: Findings, inRuns = false): string {
  const parts: string[] = [];
  for (const [label, vendors] of [...f.hits].sort(([a], [b]) => a.localeCompare(b))) parts.push(`${list(vendors)} ${vendors.size === 1 ? 'sends' : 'send'} hits in the ${label} state`);
  for (const [label, vendors] of [...f.identifiers].sort(([a], [b]) => a.localeCompare(b))) parts.push(`identifiers go out to ${list(vendors)} in the ${label} state`);
  const named = f.identifiers.size > 0;
  const shown = (checks: Map<string, number>) => new Map([...checks].filter(([name]) => !(named && name === 'deniedIdentifiers')));
  if (parts.length === 0 && f.unchecked === 0) parts.push('no leaks');
  if (f.failed > 0) parts.push(`${plural(f.failed, 'rule')} failed`);
  parts.push(...checkParts(shown(f.failedChecks), 'failed', inRuns));
  if (f.unchecked > 0) parts.push(`${plural(f.unchecked, 'expectation')} could not be checked`);
  if (f.warned > 0) parts.push(`${plural(f.warned, 'rule')} warned`);
  parts.push(...checkParts(shown(f.warnedChecks), 'warned', inRuns));
  return parts.join('; ');
}

export function runVerdict(model: ReportModel): string {
  const findings = emptyFindings();
  addFindings(findings, model);
  return `Verdict: ${findingsSentence(findings)}.`;
}
