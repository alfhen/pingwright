import { readRun, type RunRecords } from '@pingwright/core';
import { diffRuns } from '@pingwright/expect';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { SuiteManifest } from '../suite.ts';
import { buildReportModel, type ReportModel } from './model.ts';
import { definitionList, escapeHtml, page, runHeader, runSections } from './render.ts';

export interface SuiteCellView {
  variant: string;
  status: string;
  exitCode: number;
  /** Undefined when the manifest names no record or the record could not be read. */
  model: ReportModel | undefined;
}

export interface DiffRow {
  epoch: string;
  vendor: string;
  event: string;
  added: number;
  removed: number;
  changed: number;
  countMismatches: number;
}

export interface DiffView {
  scenario: string;
  from: string;
  to: string;
  warnings: string[];
  rows: DiffRow[];
  flags: { kind: string; host: string; a: number; b: number }[];
}

export interface SuiteReportModel {
  header: { id: string; startedAt: string; host: string; variants: string[]; exitCode: number };
  warnings: string[];
  scenarios: { name: string; cells: SuiteCellView[] }[];
  diffs: DiffView[];
}

export type SuiteRecords = ReadonlyMap<string, RunRecords | undefined>;

export const recordKey = (scenario: string, variant: string): string => JSON.stringify([scenario, variant]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function diffView(scenario: string, from: string, to: string, a: RunRecords, b: RunRecords): DiffView {
  const result = diffRuns(a, b);
  const rows = new Map<string, DiffRow>();
  const rowOf = (key: { epoch: string; vendor: string; event: string }): DiffRow => {
    const id = JSON.stringify([key.epoch, key.vendor, key.event]);
    let row = rows.get(id);
    if (!row) rows.set(id, (row = { epoch: key.epoch, vendor: key.vendor, event: key.event || '(no event)', added: 0, removed: 0, changed: 0, countMismatches: 0 }));
    return row;
  };
  for (const h of result.added) rowOf(h.key).added++;
  for (const h of result.removed) rowOf(h.key).removed++;
  for (const c of result.changed) rowOf(c.key).changed++;
  for (const m of result.countMismatches) rowOf(m.key).countMismatches++;
  return {
    scenario,
    from,
    to,
    warnings: result.warnings,
    rows: [...rows.values()].sort((x, y) => x.epoch.localeCompare(y.epoch) || x.vendor.localeCompare(y.vendor) || x.event.localeCompare(y.event)),
    flags: result.flags.filter((f) => !f.allowed).map((f) => ({ kind: f.kind, host: f.host, a: f.a, b: f.b })),
  };
}

/** Diffs run from the first variant to each other, as the suite table does. */
export function buildSuiteModel(manifest: SuiteManifest, records: SuiteRecords): SuiteReportModel {
  const warnings: string[] = [];
  const names = [...new Set(manifest.cells.map((c) => c.scenario))];
  const scenarios = names.map((name) => ({
    name,
    cells: manifest.variants.flatMap((variant): SuiteCellView[] => {
      const cell = manifest.cells.find((c) => c.scenario === name && c.variant === variant);
      if (!cell) return [];
      const loaded = records.get(recordKey(name, variant));
      if (!loaded && cell.status !== 'skipped') warnings.push(`${name} (${variant}): no record, so the run is not in this report`);
      if (loaded?.truncatedAtLine) warnings.push(`${name} (${variant}): record is truncated at line ${loaded.truncatedAtLine}, so later records are missing from this report`);
      return [{ variant, status: cell.status, exitCode: cell.exitCode, model: loaded && buildReportModel(loaded) }];
    }),
  }));

  const [first, ...others] = manifest.variants;
  const diffs: DiffView[] = [];
  for (const name of names) {
    const a = records.get(recordKey(name, first!));
    for (const to of others) {
      const b = records.get(recordKey(name, to));
      if (a && b) diffs.push(diffView(name, first!, to, a, b));
    }
  }

  return {
    header: {
      id: manifest.id,
      startedAt: new Date(manifest.startedAt).toISOString(),
      host: hostOf(manifest.site),
      variants: manifest.variants,
      exitCode: manifest.exitCode,
    },
    warnings,
    scenarios,
    diffs,
  };
}

function isManifest(value: unknown): value is SuiteManifest {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    m.suiteSchemaVersion === 1 &&
    typeof m.id === 'string' &&
    typeof m.startedAt === 'number' &&
    Number.isFinite(m.startedAt) &&
    typeof m.site === 'string' &&
    typeof m.exitCode === 'number' &&
    Array.isArray(m.variants) &&
    m.variants.every((v) => typeof v === 'string') &&
    Array.isArray(m.cells) &&
    m.cells.every((c: unknown) => {
      const cell = c as Record<string, unknown> | null;
      return typeof cell === 'object' && cell !== null && typeof cell.scenario === 'string' && typeof cell.variant === 'string' && typeof cell.status === 'string' && typeof cell.exitCode === 'number';
    })
  );
}

/** Throws when `dir` holds no readable suite manifest. A record that cannot be read is left out, and the model warns about it. */
export async function loadSuite(dir: string): Promise<{ manifest: SuiteManifest; records: SuiteRecords }> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(dir, 'suite.json'), 'utf8'));
  } catch {
    throw new Error(`${dir} has no readable suite.json. report reads one .jsonl run record or a suite directory.`);
  }
  if (!isManifest(manifest)) throw new Error(`${join(dir, 'suite.json')} is not a suite manifest`);
  const records = new Map<string, RunRecords | undefined>();
  for (const cell of manifest.cells) {
    const name = cell.record;
    if (typeof name !== 'string' || name !== basename(name)) continue;
    records.set(recordKey(cell.scenario, cell.variant), await readRun(join(dir, name)).catch(() => undefined));
  }
  return { manifest, records };
}

function diffTable(d: DiffView): string {
  const heading = `<h3>${escapeHtml(d.scenario)}: ${escapeHtml(d.from)} to ${escapeHtml(d.to)}</h3>`;
  const warnings = d.warnings.map((w) => `<p class="warn-box">${escapeHtml(w)}</p>`).join('');
  if (d.rows.length === 0 && d.flags.length === 0) return `${heading}${warnings}<p class="empty">No differences.</p>`;
  const flags = d.flags.length
    ? `<ul class="fields">${d.flags.map((f) => `<li>flag ${escapeHtml(f.kind)} ${escapeHtml(f.host || '(no host)')}: ${f.a} to ${f.b}</li>`).join('')}</ul>`
    : '';
  const body = d.rows
    .map((r) => `<tr><td>${escapeHtml(r.epoch)}</td><td>${escapeHtml(r.vendor)}</td><td>${escapeHtml(r.event)}</td><td>${r.added}</td><td>${r.removed}</td><td>${r.changed}</td><td>${r.countMismatches}</td></tr>`)
    .join('');
  const table = d.rows.length
    ? `<div class="scroll"><table class="diff"><thead><tr><th scope="col">Epoch</th><th scope="col">Vendor</th><th scope="col">Event</th><th scope="col">Added</th><th scope="col">Removed</th><th scope="col">Changed</th><th scope="col">Count differs</th></tr></thead><tbody>${body}</tbody></table></div>`
    : '';
  return `${heading}${warnings}${table}${flags}`;
}

function overview(model: SuiteReportModel): string {
  const head = model.header.variants.map((v) => `<th scope="col">${escapeHtml(v)}</th>`).join('');
  const rows = model.scenarios
    .map((s) => {
      const cells = model.header.variants.map((v) => {
        const cell = s.cells.find((c) => c.variant === v);
        return `<td>${cell ? `${escapeHtml(cell.status.toUpperCase())} (exit ${Number(cell.exitCode)})` : ''}</td>`;
      });
      return `<tr><th scope="row">${escapeHtml(s.name)}</th>${cells.join('')}</tr>`;
    })
    .join('');
  return `<div class="scroll"><table><thead><tr><th scope="col">Scenario</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

export function renderSuiteReport(model: SuiteReportModel): string {
  const h = model.header;
  const warnings = model.warnings.map((w) => `<p class="warn-box">Warning: ${escapeHtml(w)}</p>`).join('');
  const scenarios = model.scenarios
    .map((s) => {
      const cells = s.cells
        .map((c) => {
          const title = `<h3>${escapeHtml(s.name)} (${escapeHtml(c.variant)}): ${escapeHtml(c.status.toUpperCase())}</h3>`;
          if (!c.model) return `${title}<p class="empty">${c.status === 'skipped' ? 'Skipped.' : 'No record to show.'}</p>`;
          return `${title}${definitionList(runHeader(c.model.header))}${runSections(c.model, 'h4')}`;
        })
        .join('');
      return `<section><h2>${escapeHtml(s.name)}</h2>${cells}</section>`;
    })
    .join('');
  const diffs = model.diffs.length ? model.diffs.map(diffTable).join('') : '<p class="empty">No variant pair has two records to compare.</p>';
  return page(`<h1>Suite ${escapeHtml(h.id)}</h1>
${definitionList([
  ['Started', h.startedAt],
  ['Site host', h.host],
  ['Variants', h.variants.join(', ')],
  ['Exit code', String(Number(h.exitCode))],
])}
${warnings}
<h2>Results</h2>
${overview(model)}
<h2>Diff per variant pair</h2>
${diffs}
${scenarios}`);
}
