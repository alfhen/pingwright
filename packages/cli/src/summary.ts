import type { Result, RunRecords, Severity } from '@pingwright/core';

export interface Summary {
  runId: string;
  path: string;
  /** Every result passed, warnings included. */
  pass: boolean;
  /** No result failed at `fail` severity. The exit code is 0 exactly when this is true. */
  ok: boolean;
  hits: Record<string, Record<string, number>>;
  epochs: { label: string; state?: string; startT: number; endT: number | null }[];
  flags: { kind: string; detail: string }[];
  results: { expectation: string; pass: boolean; severity?: Severity; message: string | undefined; evidence: string[] }[];
}

const EVIDENCE_CAP = 5;
const PATH_EXAMPLES = 3;
const GROUPED_KINDS = new Set(['unknownDestination', 'firstPartySubdomain']);

export function countHits(hits: RunRecords['hits']): Summary['hits'] {
  const out: Summary['hits'] = {};
  for (const hit of hits) {
    const events = (out[hit.vendor] ??= {});
    const name = hit.event ?? '(no event)';
    events[name] = (events[name] ?? 0) + 1;
  }
  return out;
}

function stateName(state: RunRecords['consentEpochs'][number]['state']): string {
  const known = Object.values(state).filter((v) => v !== 'unknown');
  if (known.length === 0) return 'unknown';
  return known.every((v) => v === known[0]) ? known[0]! : 'mixed';
}

export function buildSummary(records: RunRecords, results: Result[], path: string): Summary {
  return {
    runId: records.run.id,
    path,
    pass: results.every((r) => r.pass),
    ok: results.every(passesGate),
    hits: countHits(records.hits),
    epochs: records.consentEpochs.map((e) => ({ label: e.label, state: stateName(e.state), startT: e.startT, endT: e.endT })),
    flags: records.flags.map((f) => ({ kind: f.kind, detail: f.detail })),
    results: results.map((r) => ({ expectation: r.expectation, pass: r.pass, message: r.message, evidence: r.evidence, ...(r.severity && { severity: r.severity }) })),
  };
}

function passesGate(r: { pass: boolean; severity?: Severity }): boolean {
  return r.pass || r.severity === 'warn';
}

export function exitCodeFor(results: Result[]): 0 | 1 {
  return results.every(passesGate) ? 0 : 1;
}

function formatFlags(flags: Summary['flags']): string[] {
  const lines: string[] = [];
  const groups = new Map<string, { kind: string; host: string; count: number; paths: Set<string> }>();
  for (const f of flags) {
    const target = groupTarget(f);
    if (!target) {
      lines.push(`  ${f.kind}: ${f.detail}`);
      continue;
    }
    const { label, url } = target;
    const key = `${f.kind} ${label}`;
    const group = groups.get(key) ?? { kind: f.kind, host: label, count: 0, paths: new Set() };
    group.count += 1;
    group.paths.add(url.pathname);
    groups.set(key, group);
  }
  for (const { kind, host, count, paths } of groups.values()) {
    const shown = [...paths].slice(0, PATH_EXAMPLES);
    const more = paths.size - shown.length;
    lines.push(`  ${kind}: ${host} x${count} (${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''})`);
  }
  return lines;
}

function groupTarget(flag: Summary['flags'][number]): { label: string; url: URL } | undefined {
  if (GROUPED_KINDS.has(flag.kind)) {
    const url = parseUrl(/\s(\S+)$/.exec(flag.detail)?.[1]);
    return url && { label: url.host, url };
  }
  if (flag.kind === 'sandboxPageUrl') {
    const match = /^(\S+) received (\S+) as the page$/.exec(flag.detail);
    const url = parseUrl(match?.[2]);
    return match && url ? { label: match[1]!, url } : undefined;
  }
  return undefined;
}

function parseUrl(text: string | undefined): URL | undefined {
  try {
    return text ? new URL(text) : undefined;
  } catch {
    return undefined;
  }
}

export function formatDuration(ms: number): string {
  const rounded = Math.round(ms);
  return rounded < 1000 ? `${rounded} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function formatSummary(summary: Summary): string {
  const lines: string[] = [];
  lines.push('Hits');
  const vendors = Object.entries(summary.hits);
  if (vendors.length === 0) lines.push('  none');
  for (const [vendor, events] of vendors) {
    lines.push(`  ${vendor}: ${Object.entries(events).map(([e, n]) => `${e} x${n}`).join(', ')}`);
  }
  lines.push('Consent epochs');
  for (const e of summary.epochs) {
    const label = e.label === 'withdrawn' && e.state ? `withdrawn, ${e.state}` : e.label;
    lines.push(`  ${label} (${e.endT === null ? 'to end' : formatDuration(e.endT - e.startT)})`);
  }
  lines.push('Flags');
  if (summary.flags.length === 0) lines.push('  none');
  lines.push(...formatFlags(summary.flags));
  lines.push('Expectations');
  for (const r of summary.results) {
    lines.push(`  ${r.pass ? 'PASS' : r.severity === 'warn' ? 'WARN' : 'FAIL'} ${r.expectation}`);
    if (!r.pass && r.message) lines.push(`       ${r.message}`);
    if (r.evidence.length) {
      const shown = r.evidence.slice(0, EVIDENCE_CAP);
      const more = r.evidence.length - shown.length;
      lines.push(`       evidence: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
    }
  }
  const failed = summary.results.filter((r) => !passesGate(r)).length;
  const warned = summary.results.filter((r) => !r.pass && passesGate(r)).length;
  const warnings = warned > 0 ? ` with ${warned} warning${warned === 1 ? '' : 's'}` : '';
  lines.push(failed === 0 ? `Result: pass${warnings}` : `Result: fail (${failed} of ${summary.results.length})${warnings}`);
  lines.push(`Record: ${summary.path}`);
  return lines.join('\n');
}
