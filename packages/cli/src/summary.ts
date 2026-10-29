import type { Result, RunRecords } from '@pingwright/core';

export interface Summary {
  runId: string;
  path: string;
  pass: boolean;
  hits: Record<string, Record<string, number>>;
  epochs: { label: string; startT: number; endT: number | null }[];
  flags: { kind: string; detail: string }[];
  results: { expectation: string; pass: boolean; message: string | undefined; evidence: string[] }[];
}

export function countHits(hits: RunRecords['hits']): Summary['hits'] {
  const out: Summary['hits'] = {};
  for (const hit of hits) {
    const events = (out[hit.vendor] ??= {});
    const name = hit.event ?? '(no event)';
    events[name] = (events[name] ?? 0) + 1;
  }
  return out;
}

export function buildSummary(records: RunRecords, results: Result[], path: string): Summary {
  return {
    runId: records.run.id,
    path,
    pass: results.every((r) => r.pass),
    hits: countHits(records.hits),
    epochs: records.consentEpochs.map((e) => ({ label: e.label, startT: e.startT, endT: e.endT })),
    flags: records.flags.map((f) => ({ kind: f.kind, detail: f.detail })),
    results: results.map((r) => ({ expectation: r.expectation, pass: r.pass, message: r.message, evidence: r.evidence })),
  };
}

export function exitCodeFor(results: Result[]): 0 | 1 {
  return results.every((r) => r.pass) ? 0 : 1;
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
    lines.push(`  ${e.label} (${e.endT === null ? 'to end' : `${e.endT - e.startT} ms`})`);
  }
  lines.push('Flags');
  if (summary.flags.length === 0) lines.push('  none');
  for (const f of summary.flags) lines.push(`  ${f.kind}: ${f.detail}`);
  lines.push('Expectations');
  for (const r of summary.results) {
    lines.push(`  ${r.pass ? 'PASS' : 'FAIL'} ${r.expectation}`);
    if (!r.pass) {
      if (r.message) lines.push(`       ${r.message}`);
      if (r.evidence.length) lines.push(`       evidence: ${r.evidence.join(', ')}`);
    }
  }
  const failed = summary.results.filter((r) => !r.pass).length;
  lines.push(failed === 0 ? 'Result: pass' : `Result: fail (${failed} of ${summary.results.length})`);
  lines.push(`Record: ${summary.path}`);
  return lines.join('\n');
}
