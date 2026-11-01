import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRun, type Hit, type RunRecords } from '@pingwright/core';
import { diffRuns, epochForHit } from '@pingwright/expect';

export const SCHEMA_VERSION = 1;

const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUITE_ID = /^suite_[0-9A-HJKMNP-TV-Z]{26}$/;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/** A refusal the server shows to the agent as the tool's error text. */
export class ToolError extends Error {}

function shown(value: string): string {
  return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
}

export function parseRunId(value: string): string {
  if (!RUN_ID.test(value)) throw new ToolError(`Expected a run ID like run_ followed by 26 characters, found ${shown(value)}.`);
  return value;
}

export function parseSuiteId(value: string): string {
  if (!SUITE_ID.test(value)) throw new ToolError(`Expected a suite ID like suite_ followed by 26 characters, found ${shown(value)}.`);
  return value;
}

async function dirEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Run IDs with the file that holds each, newest first. Symbolic links are never followed. */
async function indexRuns(runsDir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const scan = async (dir: string) => {
    for (const entry of await dirEntries(dir)) {
      const id = entry.name.slice(0, -'.jsonl'.length);
      if (entry.isFile() && entry.name.endsWith('.jsonl') && RUN_ID.test(id)) found.set(id, join(dir, entry.name));
    }
  };
  await scan(runsDir);
  for (const entry of await dirEntries(runsDir)) {
    if (entry.isDirectory() && SUITE_ID.test(entry.name)) await scan(join(runsDir, entry.name));
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? 1 : -1)));
}

async function load(runsDir: string, runId: string): Promise<RunRecords> {
  const path = (await indexRuns(runsDir)).get(parseRunId(runId));
  if (!path) throw new ToolError(`No run ${runId} in the runs directory.`);
  return readRun(path, { onWarning: () => undefined });
}

function passesGate(r: { pass: boolean; severity?: string }): boolean {
  return r.pass || r.severity === 'warn';
}

function siteHost(site: string): string {
  try {
    return new URL(site).host;
  } catch {
    return '';
  }
}

function clampLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
}

export async function listRuns(runsDir: string, input: { limit?: number } = {}) {
  const limit = clampLimit(input.limit);
  const index = await indexRuns(runsDir);
  const runs = [];
  for (const [id, path] of index) {
    if (runs.length >= limit) break;
    try {
      const records = await readRun(path, { onWarning: () => undefined });
      runs.push({
        runId: id,
        scenario: records.run.scenario,
        siteHost: siteHost(records.run.site),
        startedAt: records.run.startedAt,
        variant: records.run.variant ?? null,
        ok: records.results.length === 0 ? null : records.results.every(passesGate),
      });
    } catch {
      // An unreadable file is left out of the list. get_summary on its ID says why.
    }
  }
  return { schemaVersion: SCHEMA_VERSION, total: index.size, runs };
}

export async function getSummary(runsDir: string, input: { runId: string }) {
  const records = await load(runsDir, input.runId);
  const hits: Record<string, Record<string, number>> = {};
  for (const hit of records.hits) {
    const events = (hits[hit.vendor] ??= {});
    const name = hit.event ?? '(no event)';
    events[name] = (events[name] ?? 0) + 1;
  }
  const flags: Record<string, number> = {};
  for (const flag of records.flags) flags[flag.kind] = (flags[flag.kind] ?? 0) + 1;
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: records.run.id,
    pass: records.results.every((r) => r.pass),
    ok: records.results.every(passesGate),
    hits,
    epochs: records.consentEpochs.map((e) => ({ label: e.label, startT: e.startT, endT: e.endT })),
    flags,
    results: records.results.map((r) => ({ expectation: r.expectation, pass: r.pass, severity: r.severity ?? 'fail' })),
  };
}

function idPresence(hit: Hit): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [name, value] of Object.entries(hit.ids)) {
    if (typeof value === 'boolean') out[name] = value;
    else if (name === 'hashes' && value) for (const [param, h] of Object.entries(value)) out[`hashes.${param}`] = h.present;
  }
  return out;
}

export async function getHits(
  runsDir: string,
  input: { runId: string; vendor?: string; event?: string; epoch?: string; limit?: number },
) {
  const records = await load(runsDir, input.runId);
  const steps = new Map(records.steps.map((s) => [s.id as string, s.label]));
  const epochs = [...records.consentEpochs].sort((a, b) => a.startT - b.startT);
  const matching = [];
  for (const hit of [...records.hits].sort((a, b) => a.t - b.t)) {
    const epoch = epochForHit(epochs, hit.t, records.run.graceWindowMs)?.label ?? 'none';
    if (input.vendor !== undefined && hit.vendor !== input.vendor) continue;
    if (input.event !== undefined && hit.event !== input.event) continue;
    if (input.epoch !== undefined && epoch !== input.epoch) continue;
    matching.push({
      hitId: hit.id,
      vendor: hit.vendor,
      event: hit.event,
      epoch,
      consent: {
        analytics: hit.consent.analytics,
        ads: hit.consent.ads,
        adUserData: hit.consent.adUserData,
        adPersonalization: hit.consent.adPersonalization,
      },
      ids: idPresence(hit),
      fields: hit.fields ?? null,
      step: hit.stepId ? (steps.get(hit.stepId) ?? null) : null,
    });
  }
  const limit = clampLimit(input.limit);
  return {
    schemaVersion: SCHEMA_VERSION,
    runId: records.run.id,
    total: matching.length,
    truncated: matching.length > limit,
    hits: matching.slice(0, limit),
  };
}

// Hit.page never leaves the server, and the diff is not keyed by page: a path can carry a per-order token.
export async function diffRunsTool(runsDir: string, input: { a: string; b: string }) {
  const a = await load(runsDir, input.a);
  const b = await load(runsDir, input.b);
  const result = diffRuns(a, b);
  const strip = <T extends { page: string | null }>(hit: T): Omit<T, 'page'> => {
    const { page, ...rest } = hit;
    void page;
    return rest;
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    a: a.run.id,
    b: b.run.id,
    warnings: result.warnings,
    added: result.added.map(strip),
    removed: result.removed.map(strip),
    changed: result.changed.map((c) => ({ ...c, a: strip(c.a), b: strip(c.b) })),
    countMismatches: result.countMismatches,
    flags: result.flags,
  };
}

function runIdOfRecord(record: unknown): string | null {
  const id = typeof record === 'string' ? record.replace(/\.jsonl$/, '') : '';
  return RUN_ID.test(id) ? id : null;
}

export async function getSuite(runsDir: string, input: { suiteId: string }) {
  const id = parseSuiteId(input.suiteId);
  const path = join(runsDir, id, 'suite.json');
  let manifest: Record<string, unknown>;
  try {
    if (!(await lstat(path)).isFile()) throw new Error('not a file');
    manifest = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new ToolError(`No readable manifest for suite ${id} in the runs directory.`);
  }
  const cells = Array.isArray(manifest.cells) ? (manifest.cells as Record<string, unknown>[]) : [];
  return {
    schemaVersion: SCHEMA_VERSION,
    suiteId: id,
    startedAt: manifest.startedAt,
    site: manifest.site,
    variants: manifest.variants,
    exitCode: manifest.exitCode,
    cells: cells.map(({ record, ...cell }) => ({ ...cell, runId: runIdOfRecord(record) })),
    diffs: manifest.diffs,
  };
}
