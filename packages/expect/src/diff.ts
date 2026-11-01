import { stripSandboxPrefix } from '@pingwright/decoders';
import type { ConsentEpoch, Hit, HitIds, RunRecords } from '@pingwright/core';
import { consentFields } from './scenario.ts';
import { epochForHit } from './evaluate.ts';

export interface DiffOptions {
  /** Adds the page path to the match key, with the Shopify sandbox prefix stripped. */
  byPage?: boolean;
}

export interface DiffKey {
  epoch: string;
  vendor: string;
  event: string;
  page?: string;
}

export interface DiffHit {
  hitId: string;
  t: number;
  step: string;
  /** The page as recorded. */
  page: string | null;
}

export interface ValueChange {
  field: string;
  a: string;
  b: string;
}

export interface ChangedHit {
  key: DiffKey;
  a: DiffHit;
  b: DiffHit;
  consent: ValueChange[];
  ids: ValueChange[];
}

export interface CountMismatch {
  key: DiffKey;
  a: number;
  b: number;
}

export interface FlagChange {
  host: string;
  kind: string;
  a: number;
  b: number;
  /** True when the scenario allows this host with `allowUnknownDestination` in both runs. */
  allowed: boolean;
}

export interface DiffResult {
  warnings: string[];
  added: Array<{ key: DiffKey } & DiffHit>;
  removed: Array<{ key: DiffKey } & DiffHit>;
  changed: ChangedHit[];
  countMismatches: CountMismatch[];
  flags: FlagChange[];
}

const NO_EPOCH = 'none';

export function diffRuns(a: RunRecords, b: RunRecords, options: DiffOptions = {}): DiffResult {
  const result: DiffResult = { warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags: [] };

  const versionA = a.run.recordSchemaVersion ?? 0;
  const versionB = b.run.recordSchemaVersion ?? 0;
  if (versionA !== versionB) {
    result.warnings.push(
      `The runs have different record schema versions (${versionA} and ${versionB}). The diff may show changes that are only differences in the record shape.`,
    );
  }

  const stepsA = stepLabels(a);
  const stepsB = stepLabels(b);
  const groupsA = groupHits(a, options);
  const groupsB = groupHits(b, options);
  const ids = [...new Set([...groupsA.keys(), ...groupsB.keys()])].sort();

  for (const id of ids) {
    const ga = groupsA.get(id);
    const gb = groupsB.get(id);
    const key = (ga ?? gb)!.key;
    const hitsA = ga?.hits ?? [];
    const hitsB = gb?.hits ?? [];
    if (hitsA.length !== hitsB.length) result.countMismatches.push({ key, a: hitsA.length, b: hitsB.length });
    const paired = Math.min(hitsA.length, hitsB.length);
    for (let i = 0; i < paired; i++) {
      const ha = hitsA[i]!;
      const hb = hitsB[i]!;
      const consent = consentChanges(ha, hb);
      const idChanges = idPresenceChanges(ha.ids, hb.ids);
      if (consent.length || idChanges.length) {
        result.changed.push({ key, a: ref(ha, stepsA), b: ref(hb, stepsB), consent, ids: idChanges });
      }
    }
    for (const h of hitsA.slice(paired)) result.removed.push({ key, ...ref(h, stepsA) });
    for (const h of hitsB.slice(paired)) result.added.push({ key, ...ref(h, stepsB) });
  }

  result.flags = flagChanges(a, b);
  return result;
}

export interface ShapeFields {
  /** The four consent states, then raw `gcs` and `gcd` (empty when absent). */
  consent: Record<string, string>;
  /** Sorted names of the IDs that are present. */
  ids: string[];
}

export interface ShapeTuple extends ShapeFields {
  count: number;
}

export interface ShapeKey {
  key: DiffKey;
  tuples: ShapeTuple[];
}

export interface ShapeChange extends ShapeFields {
  key: DiffKey;
  /** True when the key has no tuples on the other side. */
  wholeKey: boolean;
}

export interface ShapeCountChange extends ShapeFields {
  key: DiffKey;
  a: number;
  b: number;
}

export interface ShapeDiff {
  added: ShapeChange[];
  removed: ShapeChange[];
  countChanges: ShapeCountChange[];
  /** A key or tuple on one side only. A count change is not drift. */
  drift: boolean;
}

/** Groups the hits by match key and by the tuple of compared fields, with a count per tuple. Holds no hit ID, time, URL or value. */
export function hitShape(run: RunRecords, options: DiffOptions = {}): ShapeKey[] {
  const out: ShapeKey[] = [];
  const groups = groupHits(run, options);
  for (const id of [...groups.keys()].sort()) {
    const group = groups.get(id)!;
    const tuples = new Map<string, ShapeTuple>();
    for (const hit of group.hits) {
      const fields = shapeFields(hit);
      const tupleId = JSON.stringify(fields);
      const tuple = tuples.get(tupleId) ?? { ...fields, count: 0 };
      tuple.count += 1;
      tuples.set(tupleId, tuple);
    }
    out.push({ key: group.key, tuples: [...tuples].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)).map(([, t]) => t) });
  }
  return out;
}

function shapeFields(hit: Hit): ShapeFields {
  const consent: Record<string, string> = {};
  for (const f of consentFields) consent[f] = hit.consent[f];
  for (const f of ['gcs', 'gcd']) consent[f] = hit.consent.raw[f] ?? '';
  const ids = [...idPresence(hit.ids)].filter(([, present]) => present).map(([name]) => name).sort();
  return { consent, ids };
}

/** Drift is a key or tuple on one side only. The order of hits and their counts do not matter. */
export function diffShapes(a: ShapeKey[], b: ShapeKey[]): ShapeDiff {
  const result: ShapeDiff = { added: [], removed: [], countChanges: [], drift: false };
  const index = (shape: ShapeKey[]) => new Map(shape.map((k) => [JSON.stringify(k.key), k]));
  const ia = index(a);
  const ib = index(b);
  for (const id of [...new Set([...ia.keys(), ...ib.keys()])].sort()) {
    const ka = ia.get(id);
    const kb = ib.get(id);
    const key = (ka ?? kb)!.key;
    const ta = new Map((ka?.tuples ?? []).map((t) => [JSON.stringify([t.consent, t.ids]), t]));
    const tb = new Map((kb?.tuples ?? []).map((t) => [JSON.stringify([t.consent, t.ids]), t]));
    for (const [tid, t] of tb) {
      const before = ta.get(tid);
      if (!before) result.added.push({ key, consent: t.consent, ids: t.ids, wholeKey: !ka });
      else if (before.count !== t.count) result.countChanges.push({ key, consent: t.consent, ids: t.ids, a: before.count, b: t.count });
    }
    for (const [tid, t] of ta) {
      if (!tb.has(tid)) result.removed.push({ key, consent: t.consent, ids: t.ids, wholeKey: !kb });
    }
  }
  result.drift = result.added.length > 0 || result.removed.length > 0;
  return result;
}

function ref(h: Hit, steps: Map<string, string>): DiffHit {
  return { hitId: h.id, t: h.t, step: h.stepId ? (steps.get(h.stepId) ?? '') : '', page: h.page };
}

function stepLabels(run: RunRecords): Map<string, string> {
  return new Map(run.steps.map((s) => [s.id as string, s.label]));
}

interface Group {
  key: DiffKey;
  hits: Hit[];
}

function groupHits(run: RunRecords, options: DiffOptions): Map<string, Group> {
  const epochs: ConsentEpoch[] = [...run.consentEpochs].sort((x, y) => x.startT - y.startT);
  const frames = new Map(run.requests.map((r) => [r.id as string, r.frameUrl]));
  const groups = new Map<string, Group>();
  for (const hit of [...run.hits].sort((x, y) => x.t - y.t)) {
    const key: DiffKey = {
      epoch: epochForHit(epochs, hit.t)?.label ?? NO_EPOCH,
      vendor: hit.vendor,
      event: hit.event ?? '',
    };
    if (options.byPage) key.page = pagePath(hit.page ?? frames.get(hit.requestId) ?? null);
    const id = JSON.stringify(key);
    const group = groups.get(id) ?? { key, hits: [] };
    group.hits.push(hit);
    groups.set(id, group);
  }
  return groups;
}

function pagePath(page: string | null): string {
  if (page === null) return '';
  try {
    return stripSandboxPrefix(new URL(page).pathname);
  } catch {
    return stripSandboxPrefix(page);
  }
}

function consentChanges(a: Hit, b: Hit): ValueChange[] {
  const changes: ValueChange[] = [];
  for (const f of consentFields) {
    if (a.consent[f] !== b.consent[f]) changes.push({ field: f, a: a.consent[f], b: b.consent[f] });
  }
  for (const f of ['gcs', 'gcd']) {
    const va = a.consent.raw[f];
    const vb = b.consent.raw[f];
    if (va !== vb) changes.push({ field: f, a: va ?? '', b: vb ?? '' });
  }
  return changes;
}

function idPresence(ids: HitIds): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [name, value] of Object.entries(ids)) {
    if (typeof value === 'boolean') out.set(name, value);
    else if (name === 'hashes' && value) {
      for (const [hash, h] of Object.entries(value)) out.set(`hashes.${hash}`, h.present);
    }
  }
  return out;
}

function idPresenceChanges(a: HitIds, b: HitIds): ValueChange[] {
  const pa = idPresence(a);
  const pb = idPresence(b);
  const names = [...new Set([...pa.keys(), ...pb.keys()])].sort();
  const changes: ValueChange[] = [];
  for (const name of names) {
    const va = pa.get(name) ?? false;
    const vb = pb.get(name) ?? false;
    if (va !== vb) changes.push({ field: name, a: va ? 'present' : 'absent', b: vb ? 'present' : 'absent' });
  }
  return changes;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** The built-in check lists only the blocked flags as evidence when it fails, and every unknown flag when it passes. */
function allowedFlagIds(run: RunRecords): Set<string> {
  const check = run.results.find((r) => r.expectation === 'builtin: unknownDestination');
  if (!check) return new Set();
  const unknown = run.flags.filter((f) => f.kind === 'unknownDestination').map((f) => f.id as string);
  const blocked = new Set(check.pass ? [] : check.evidence);
  return new Set(unknown.filter((id) => !blocked.has(id)));
}

interface FlagCount {
  n: number;
  allowed: boolean;
}

function flagCounts(run: RunRecords): Map<string, FlagCount> {
  const requestHosts = new Map(run.requests.map((r) => [r.id as string, hostOf(r.url)]));
  const hitHosts = new Map(run.hits.map((h) => [h.id as string, requestHosts.get(h.requestId) ?? '']));
  const allowedIds = allowedFlagIds(run);
  const counts = new Map<string, FlagCount>();
  for (const flag of run.flags) {
    const host = flag.recordIds.map((id) => requestHosts.get(id) ?? hitHosts.get(id)).find((h) => h) ?? '';
    const key = JSON.stringify([host, flag.kind]);
    const count = counts.get(key) ?? { n: 0, allowed: true };
    count.n += 1;
    count.allowed &&= allowedIds.has(flag.id as string);
    counts.set(key, count);
  }
  return counts;
}

function flagChanges(a: RunRecords, b: RunRecords): FlagChange[] {
  const ca = flagCounts(a);
  const cb = flagCounts(b);
  const changes: FlagChange[] = [];
  for (const key of [...new Set([...ca.keys(), ...cb.keys()])].sort()) {
    const na = ca.get(key);
    const nb = cb.get(key);
    if ((na?.n ?? 0) === (nb?.n ?? 0)) continue;
    const [host, kind] = JSON.parse(key) as [string, string];
    const allowed = (!na || na.allowed) && (!nb || nb.allowed);
    changes.push({ host, kind, a: na?.n ?? 0, b: nb?.n ?? 0, allowed });
  }
  return changes;
}
