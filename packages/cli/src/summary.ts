import { platformHostFor } from '@tagreeve/decoders';
import type { Result, ResultNote, RunRecords, Severity } from '@tagreeve/core';
import { NOTE_TEXT } from './report/model.ts';

export interface BaselineSummary {
  /** A key or tuple is on one side only. */
  drift: boolean;
  added: number;
  removed: number;
  countChanges: number;
  warnings: string[];
  changes: string[];
}

export interface Summary {
  runId: string;
  path: string;
  /** Every result passed, warnings included, and the run shows no baseline drift. */
  pass: boolean;
  /** No result failed at `fail` severity and the run shows no baseline drift. The exit code is 0 exactly when this is true. */
  ok: boolean;
  hits: Record<string, Record<string, number>>;
  epochs: { label: string; state?: string; startT: number; endT: number | null }[];
  flags: { kind: string; detail: string }[];
  /** Optional fill entries that were skipped because the field was not on the page. */
  skippedFields?: { step: string; selector: string }[];
  results: { expectation: string; pass: boolean; severity: Severity; message: string | undefined; note?: ResultNote; evidence: string[] }[];
  /** Set when a payment step typed a provider's documented test card. Names only. */
  testPayment?: { provider: string; host: string; testMode: 'declared' | 'marker' };
  /** Set when the run was compared with a baseline. */
  baseline?: BaselineSummary;
}

const EVIDENCE_CAP = 5;
const PATH_EXAMPLES = 3;
const SANDBOX_PATH_EXAMPLES = 1;
const PURPOSE_ORDER = ['telemetry', 'checkout', 'payments', 'cdn'] as const;
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

function testPaymentOf(records: RunRecords): Summary['testPayment'] {
  const payment = (records.steps ?? []).find((s) => s.payment)?.payment;
  return payment && { provider: payment.provider, host: new URL(records.run.site).hostname, testMode: payment.testMode ?? 'marker' };
}

export function buildSummary(records: RunRecords, results: Result[], path: string): Summary {
  const testPayment = testPaymentOf(records);
  return {
    runId: records.run.id,
    path,
    pass: results.every((r) => r.pass),
    ok: results.every(passesGate),
    hits: countHits(records.hits),
    epochs: records.consentEpochs.map((e) => ({ label: e.label, state: stateName(e.state), startT: e.startT, endT: e.endT })),
    flags: records.flags.map((f) => ({ kind: f.kind, detail: f.detail })),
    ...(testPayment && { testPayment }),
    skippedFields: (records.steps ?? []).flatMap((s) => (s.skippedFields ?? []).map((selector) => ({ step: s.label, selector }))),
    results: results.map((r) => ({ expectation: r.expectation, pass: r.pass, message: r.message, ...(r.note && { note: r.note }), evidence: r.evidence, severity: r.severity ?? 'fail' })),
  };
}

export function applyBaseline(summary: Summary, baseline: BaselineSummary): void {
  summary.baseline = baseline;
  if (baseline.drift) {
    summary.pass = false;
    summary.ok = false;
  }
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
  let realData = 0;
  for (const f of flags) {
    if (f.kind === 'possibleRealData') {
      realData += 1;
      continue;
    }
    if (f.kind === 'platformHost' && platformOf(f)) continue;
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
    const shown = [...paths].slice(0, kind === 'sandboxPageUrl' ? SANDBOX_PATH_EXAMPLES : PATH_EXAMPLES);
    const more = paths.size - shown.length;
    lines.push(`  ${kind}: ${host} x${count} (${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''})`);
  }
  if (realData > 0) lines.push(`  possibleRealData: x${realData}`);
  lines.push(...platformHostLines(flags));
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
  if (summary.testPayment) {
    const { provider, host, testMode } = summary.testPayment;
    lines.push(`TEST PAYMENT: ${provider} on ${host} (test mode ${testMode === 'declared' ? 'declared' : 'on page'})`);
  }
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
  if (summary.skippedFields?.length) {
    lines.push('Skipped fields');
    for (const step of new Set(summary.skippedFields.map((f) => f.step))) {
      lines.push(`  ${step}`);
      for (const f of summary.skippedFields) if (f.step === step) lines.push(`    SKIPPED FIELD ${f.selector} (not present)`);
    }
  }
  lines.push('Expectations');
  for (const r of summary.results) {
    lines.push(`  ${r.pass ? 'PASS' : r.severity === 'warn' ? 'WARN' : 'FAIL'} ${r.expectation}`);
    if (r.note) lines.push(`       note: ${NOTE_TEXT[r.note]}`);
    if (!r.pass && r.message) lines.push(`       ${r.message}`);
    if (r.evidence.length) {
      const shown = r.evidence.slice(0, EVIDENCE_CAP);
      const more = r.evidence.length - shown.length;
      lines.push(`       evidence: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`);
    }
  }
  if (summary.baseline) {
    const b = summary.baseline;
    lines.push(`Baseline: ${b.drift ? 'drift' : 'no drift'} (${b.added} added, ${b.removed} removed, ${b.countChanges} count changes)`);
    for (const w of b.warnings) lines.push(`  Warning: ${w}`);
    for (const c of b.changes) lines.push(`  ${c}`);
  }
  const failed = summary.results.filter((r) => !passesGate(r)).length;
  const warned = summary.results.filter((r) => !r.pass && passesGate(r)).length;
  const warnings = warned > 0 ? ` with ${warned} warning${warned === 1 ? '' : 's'}` : '';
  if (failed === 0 && summary.baseline?.drift) lines.push(`Result: fail (baseline drift)${warnings}`);
  else lines.push(failed === 0 ? `Result: pass${warnings}` :`Result: fail (${failed} of ${summary.results.length})${warnings}`);
  lines.push(`Record: ${summary.path}`);
  return lines.join('\n');
}

function platformOf(flag: Summary['flags'][number]) {
  const url = parseUrl(/\s(\S+)$/.exec(flag.detail)?.[1]);
  const entry = url && platformHostFor({ url: url.href });
  return url && entry ? { url, entry } : undefined;
}

function platformHostLines(flags: Summary['flags']): string[] {
  const byPlatform = new Map<string, { requests: number; hosts: Set<string>; purposes: Map<string, number> }>();
  for (const f of flags) {
    if (f.kind !== 'platformHost') continue;
    const found = platformOf(f);
    if (!found) continue;
    const { url, entry } = found;
    const group = byPlatform.get(entry.platform) ?? { requests: 0, hosts: new Set(), purposes: new Map() };
    group.requests += 1;
    group.hosts.add(url.host);
    group.purposes.set(entry.purpose, (group.purposes.get(entry.purpose) ?? 0) + 1);
    byPlatform.set(entry.platform, group);
  }
  return [...byPlatform].map(([platform, { requests, hosts, purposes }]) => {
    const parts = PURPOSE_ORDER.filter((p) => purposes.has(p)).map((p) => `${p} ${purposes.get(p)}`);
    return `  platformHost: ${platform}, ${requests} ${requests === 1 ? 'request' : 'requests'} to ${hosts.size} ${hosts.size === 1 ? 'host' : 'hosts'} (${parts.join(', ')})`;
  });
}
