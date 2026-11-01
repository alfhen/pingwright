import { readFile, writeFile } from 'node:fs/promises';
import { readRun, type RunRecords } from '@pingwright/core';
import { diffShapes, hitShape, type DiffKey, type ShapeDiff, type ShapeKey } from '@pingwright/expect';
import type { BaselineArgs } from './args.ts';
import type { Io } from './run.ts';
import type { BaselineSummary } from './summary.ts';

export const BASELINE_SCHEMA_VERSION = 1;

export interface BaselineFile {
  baselineSchemaVersion: number;
  scenario: string;
  /** The host of the site, without scheme, port or path. */
  site: string;
  byPage: boolean;
  keys: ShapeKey[];
}

export class BaselineError extends Error {}

function hostOf(site: string): string {
  try {
    return new URL(site).hostname;
  } catch {
    return '';
  }
}

export function buildBaseline(records: RunRecords, byPage: boolean): BaselineFile {
  return {
    baselineSchemaVersion: BASELINE_SCHEMA_VERSION,
    scenario: records.run.scenario,
    site: hostOf(records.run.site),
    byPage,
    keys: hitShape(records, { byPage }),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function validKey(k: unknown): k is ShapeKey {
  if (!isRecord(k) || !isRecord(k.key) || !Array.isArray(k.tuples)) return false;
  const { epoch, vendor, event, page } = k.key;
  if (typeof epoch !== 'string' || typeof vendor !== 'string' || typeof event !== 'string') return false;
  if (page !== undefined && typeof page !== 'string') return false;
  return k.tuples.every(
    (t) =>
      isRecord(t) &&
      isRecord(t.consent) &&
      Object.values(t.consent).every((v) => typeof v === 'string') &&
      isStringArray(t.ids) &&
      Number.isInteger(t.count) &&
      (t.count as number) >= 1,
  );
}

/** The messages never quote the file, which a user may have edited by hand. */
export function parseBaseline(text: string, label: string): BaselineFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BaselineError(`${label} is not valid JSON`);
  }
  if (!isRecord(json) || json.baselineSchemaVersion === undefined) throw new BaselineError(`${label} is not a baseline file`);
  if (json.baselineSchemaVersion !== BASELINE_SCHEMA_VERSION) {
    const found = typeof json.baselineSchemaVersion === 'number' ? json.baselineSchemaVersion : '?';
    throw new BaselineError(`${label} has baselineSchemaVersion ${found}, and this Pingwright reads ${BASELINE_SCHEMA_VERSION}`);
  }
  if (typeof json.scenario !== 'string' || typeof json.site !== 'string' || typeof json.byPage !== 'boolean' || !Array.isArray(json.keys) || !json.keys.every(validKey)) {
    throw new BaselineError(`${label} is not a valid baseline file`);
  }
  return json as unknown as BaselineFile;
}

export async function readBaseline(path: string): Promise<BaselineFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new BaselineError(`Cannot read ${path}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
  }
  return parseBaseline(text, path);
}

function keyLabel(key: DiffKey): string {
  const page = key.page === undefined ? '' : `, page ${key.page || '(none)'}`;
  return `${key.vendor} ${key.event || '(no event)'} [epoch ${key.epoch}${page}]`;
}

function tupleLabel(t: { consent: Record<string, string>; ids: string[] }): string {
  const consent = Object.entries(t.consent).map(([k, v]) => `${k}=${v || '-'}`).join(' ');
  return `${consent}; ids: ${t.ids.length ? t.ids.join(', ') : 'none'}`;
}

export function describeDiff(diff: ShapeDiff): string[] {
  const lines: string[] = [];
  for (const c of diff.added) lines.push(c.wholeKey ? `added ${keyLabel(c.key)}` : `added tuple ${keyLabel(c.key)}: ${tupleLabel(c)}`);
  for (const c of diff.removed) lines.push(c.wholeKey ? `removed ${keyLabel(c.key)}` : `removed tuple ${keyLabel(c.key)}: ${tupleLabel(c)}`);
  for (const c of diff.countChanges) lines.push(`count ${keyLabel(c.key)}: ${c.a} -> ${c.b} (not drift)`);
  return [...new Set(lines)];
}

/** The baseline decides `byPage`, so the new run is shaped the way the file was. A different scenario or site is a warning, not an error. */
export function compareBaseline(baseline: BaselineFile, records: RunRecords): BaselineSummary {
  const warnings: string[] = [];
  if (baseline.scenario !== records.run.scenario) {
    warnings.push(`The baseline is from scenario ${baseline.scenario}, and this run is ${records.run.scenario}.`);
  }
  const host = hostOf(records.run.site);
  if (baseline.site !== host) warnings.push(`The baseline is from site ${baseline.site || '(none)'}, and this run is ${host || '(none)'}.`);
  const diff = diffShapes(baseline.keys, hitShape(records, { byPage: baseline.byPage }));
  const changes = describeDiff(diff);
  const counted = (prefix: string) => changes.filter((c) => c.startsWith(prefix)).length;
  return { drift: diff.drift, added: counted('added '), removed: counted('removed '), countChanges: counted('count '), warnings, changes };
}

export async function baselineCommand(args: BaselineArgs, io: Io): Promise<number> {
  let records: RunRecords;
  try {
    records = await readRun(args.input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(args.input) ? message : `Cannot read ${args.input}: ${message}`);
  }
  if (records.truncatedAtLine) {
    io.stderr(`Warning: ${args.input} is truncated at line ${records.truncatedAtLine}. The baseline lacks the later records.\n`);
  }
  const baseline = buildBaseline(records, args.byPage);
  await writeFile(args.output, `${JSON.stringify(baseline, null, 2)}\n`);
  const hits = baseline.keys.reduce((n, k) => n + k.tuples.reduce((m, t) => m + t.count, 0), 0);
  io.stdout(`Baseline ${args.output}: ${baseline.keys.length} keys, ${hits} hits\n`);
  return 0;
}
