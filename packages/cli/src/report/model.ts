import type { ConsentEpoch, ConsentState, Hit, Result, ResultNote, RunRecords } from '@pingwright/core';
import { guardFieldName, identifierClass, identifierSignal } from '@pingwright/decoders';
import { DEFAULT_GRACE_MS, effectiveConsentAt, epochForHit } from '@pingwright/expect';

export type Mark = 'full' | 'ping' | 'nothing' | 'leak' | 'unchecked' | 'mixed';
export type EpochLabel = ConsentEpoch['label'];

export interface Segment {
  mark: Mark;
  label: string;
  hits: number;
}

export interface VendorRow {
  vendor: string;
  hits: number;
  segments: Segment[];
}

export type ExpectationStatus = 'PASS' | 'WARN' | 'FAIL' | 'CANNOT EVALUATE';

export interface ExpectationView {
  status: ExpectationStatus;
  /** `must`, `mustNot`, `builtin`, or `rule` when the expectation could not be read. */
  kind: string;
  /** Rule keys and names. Never the values of `params`, `ids` or `page`. */
  text: string;
  severity: 'fail' | 'warn';
  note: string | undefined;
  evidence: string[];
  evidenceCount: number;
}

export interface FlagView {
  kind: string;
  count: number;
  hosts: string[];
}

export interface FieldsView {
  vendor: string;
  names: string[];
}

export interface ReportModel {
  header: {
    scenario: string;
    variant: string | undefined;
    runId: string;
    startedAt: string;
    networkMode: string;
    host: string;
    pingwrightVersion: string;
    schemaVersion: number;
  };
  columns: { label: EpochLabel; index: number }[];
  rows: VendorRow[];
  expectations: ExpectationView[];
  flags: FlagView[];
  /** Undefined on a record that holds no field names (schema version below 2). */
  fields: FieldsView[] | undefined;
}

export const NOTE_TEXT: Record<ResultNote, string> = {
  stubNoCookies: 'stub mode: stubbed endpoints set no cookies, so this pass says nothing about server cookies',
  cannotEvaluateBody: 'cannot evaluate: body not fully recorded',
  fieldsNotRecorded: 'cannot evaluate: field names not recorded',
};

const WORST_FIRST: Mark[] = ['leak', 'unchecked', 'mixed', 'full', 'ping'];
const CONSENT_FIELDS: (keyof ConsentState)[] = ['analytics', 'ads', 'adUserData', 'adPersonalization'];
const MAX_EVIDENCE = 5;
const MAX_VALUE = 80;
const SHOWN_VALUE_KEYS = new Set(['vendor', 'event', 'in', 'before', 'after', 'host', 'count', 'outcome', 'transport', 'cookie']);
const MIXED_HIT = 'some signals denied';

interface Verdict {
  mark: Mark;
  label: string;
}

function flatten(entry: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [sub, inner] of Object.entries(value)) flat[`${key}.${sub}`] = inner;
    } else flat[key] = value;
  }
  return flat;
}

function consentScoped(entry: Record<string, unknown>): boolean {
  const flat = flatten(entry);
  const where = flat.in;
  if (typeof where === 'string' && /^epoch\(\s*(?:label=)?(?:denied|withdrawn)\s*\)$|^epoch\(\s*\w+=denied\s*\)$/.test(where)) return true;
  if (flat.before === 'consent') return true;
  return Object.entries(flat).some(([key, value]) => key.startsWith('consent.') && value === 'denied');
}

function parseEntry(result: Result): { kind: 'must' | 'mustNot'; entry: Record<string, unknown> } | undefined {
  const m = /^(must|mustNot): ([\s\S]*)$/.exec(result.expectation);
  if (!m) return undefined;
  try {
    const entry: unknown = JSON.parse(m[2]!);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined;
    return { kind: m[1] as 'must' | 'mustNot', entry: entry as Record<string, unknown> };
  } catch {
    return undefined;
  }
}

function scalar(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

function shown(value: unknown): string | undefined {
  const one = scalar(value);
  if (one !== undefined) return one.slice(0, MAX_VALUE);
  if (Array.isArray(value) && value.every((v) => scalar(v) !== undefined)) return value.map(scalar).join('|').slice(0, MAX_VALUE);
  return undefined;
}

function valueFreeForm(kind: string, entry: Record<string, unknown>): string {
  const parts = Object.entries(flatten(entry)).map(([key, value]) => {
    const keepsValue = SHOWN_VALUE_KEYS.has(key) || key.startsWith('body.') || (key.startsWith('consent.') && ['granted', 'denied', 'unknown'].includes(String(value)));
    const text = keepsValue ? shown(value) : undefined;
    return text === undefined ? key : `${key}: ${text}`;
  });
  return parts.length ? `${kind}: ${parts.join(', ')}` : kind;
}

function expectationView(result: Result): ExpectationView {
  const severity = result.severity ?? 'fail';
  const parsed = parseEntry(result);
  let kind = 'rule';
  let text = 'rule';
  if (parsed) {
    kind = parsed.kind;
    text = valueFreeForm(parsed.kind, parsed.entry);
  } else if (/^builtin: [A-Za-z]+$/.test(result.expectation)) {
    kind = 'builtin';
    text = result.expectation;
  }
  const cannot = !result.pass && (result.note === 'cannotEvaluateBody' || result.note === 'fieldsNotRecorded');
  const status: ExpectationStatus = cannot ? 'CANNOT EVALUATE' : result.pass ? 'PASS' : severity === 'warn' ? 'WARN' : 'FAIL';
  return {
    status,
    kind,
    text,
    severity,
    note: result.note ? NOTE_TEXT[result.note] : undefined,
    evidence: result.evidence.slice(0, MAX_EVIDENCE),
    evidenceCount: result.evidence.length,
  };
}

/** Hit IDs in the evidence of a failed `mustNot` that is scoped to a denied or withdrawn consent state. */
function consentScopedLeakIds(results: readonly Result[]): Set<string> {
  const ids = new Set<string>();
  for (const result of results) {
    if (result.pass || result.note === 'cannotEvaluateBody' || result.note === 'fieldsNotRecorded') continue;
    const parsed = parseEntry(result);
    if (parsed?.kind !== 'mustNot' || !consentScoped(parsed.entry)) continue;
    for (const id of result.evidence) ids.add(id);
  }
  return ids;
}

function judge(hit: Hit, state: ConsentState, undecided: boolean, named: ReadonlySet<string>): Verdict {
  const known = CONSENT_FIELDS.map((f) => state[f]).filter((v) => v !== 'unknown');
  const denied = known.includes('denied');
  const granted = known.includes('granted');
  const idFields = hit.idFields;
  const flagged = (idFields ?? []).some((name) => identifierSignal(identifierClass(name), state).value === 'denied');
  if (named.has(hit.id) || flagged) return { mark: 'leak', label: 'identifiers sent while denied' };
  if (denied && (hit.fieldsComplete === false || idFields === undefined)) return { mark: 'unchecked', label: 'body not fully recorded' };
  if (denied && granted) return { mark: 'mixed', label: MIXED_HIT };
  if (denied) {
    return idFields!.length > 0
      ? { mark: 'unchecked', label: 'identifier names, consent signal unknown' }
      : { mark: 'ping', label: 'hit sent while denied, no identifiers recorded' };
  }
  if (granted) return { mark: 'full', label: '' };
  return { mark: 'full', label: undecided ? 'before an answer' : 'consent state unknown' };
}

function segmentOf(verdicts: Verdict[]): Segment {
  if (verdicts.length === 0) return { mark: 'nothing', label: '', hits: 0 };
  const hits = verdicts.length;
  const has = (m: Mark) => verdicts.some((v) => v.mark === m);
  const mark = WORST_FIRST.find(has)!;
  if (mark === 'full' && has('ping')) return { mark: 'mixed', label: 'granted and denied hits', hits };
  const own = verdicts.filter((v) => v.mark === mark);
  let label = own.every((v) => v.label === own[0]!.label) ? own[0]!.label : '';
  if (mark === 'mixed') label = MIXED_HIT;
  return { mark, label, hits };
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

function flagViews(records: RunRecords): FlagView[] {
  const hostByRecord = new Map<string, string>();
  for (const r of records.requests) {
    const host = hostOf(r.url);
    if (host) hostByRecord.set(r.id, host);
  }
  for (const h of records.hits) {
    const host = hostByRecord.get(h.requestId);
    if (host) hostByRecord.set(h.id, host);
  }
  const byKind = new Map<string, { count: number; hosts: Set<string> }>();
  for (const flag of records.flags) {
    const entry = byKind.get(flag.kind) ?? { count: 0, hosts: new Set<string>() };
    entry.count++;
    for (const id of flag.recordIds) {
      const host = hostByRecord.get(id);
      if (host) entry.hosts.add(host);
    }
    byKind.set(flag.kind, entry);
  }
  return [...byKind].map(([kind, { count, hosts }]) => ({ kind, count, hosts: [...hosts].sort() })).sort((a, b) => a.kind.localeCompare(b.kind));
}

export function buildReportModel(records: RunRecords): ReportModel {
  const { run } = records;
  const graceMs = run.graceWindowMs ?? DEFAULT_GRACE_MS;
  const epochs = [...records.consentEpochs].sort((a, b) => a.startT - b.startT);
  const named = consentScopedLeakIds(records.results);

  const placed = records.hits.map((hit) => {
    const epoch = epochForHit(epochs, hit.t, graceMs);
    const state = effectiveConsentAt(hit, epochs, graceMs);
    const column = epoch ? epochs.indexOf(epoch) : -1;
    return { hit, state, column, verdict: judge(hit, state, !epoch || epoch.label === 'undecided', named) };
  });

  const synthetic = epochs.length === 0 || placed.some((p) => p.column < 0);
  const offset = synthetic ? 1 : 0;
  const columns: ReportModel['columns'] = [
    ...(synthetic ? [{ label: 'undecided' as EpochLabel, index: 0 }] : []),
    ...epochs.map((e, i) => ({ label: e.label, index: i + offset })),
  ];

  const vendors = [...new Set(records.hits.map((h) => h.vendor))].sort();
  const rows: VendorRow[] = vendors.map((vendor) => {
    const own = placed.filter((p) => p.hit.vendor === vendor);
    return {
      vendor,
      hits: own.length,
      segments: columns.map((col) => segmentOf(own.filter((p) => p.column + offset === col.index).map((p) => p.verdict))),
    };
  });

  const version = run.recordSchemaVersion ?? 0;
  let fields: FieldsView[] | undefined;
  if (version >= 2) {
    fields = vendors
      .map((vendor) => {
        const names = new Set<string>();
        for (const p of placed) {
          if (p.hit.vendor !== vendor || !CONSENT_FIELDS.some((f) => p.state[f] === 'denied')) continue;
          for (const name of p.hit.fields ?? []) names.add(guardFieldName(name));
        }
        return { vendor, names: [...names].sort() };
      })
      .filter((v) => v.names.length > 0);
  }

  return {
    header: {
      scenario: run.scenario,
      variant: run.variant,
      runId: run.id,
      startedAt: new Date(run.startedAt).toISOString(),
      networkMode: run.networkMode,
      host: hostOf(run.site) ?? '',
      pingwrightVersion: run.pingwrightVersion,
      schemaVersion: version,
    },
    columns,
    rows,
    expectations: records.results.map(expectationView),
    flags: flagViews(records),
    fields,
  };
}
