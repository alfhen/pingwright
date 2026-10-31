import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { readRun, ulid } from '@pingwright/core';
import type { TrackerEntry } from '@pingwright/decoders';
import { diffRuns, parseScenario, ScenarioError, type Scenario } from '@pingwright/expect';
import { GtmOverrideError, hasHandoff, parseTestGtmOrigin, TEST_GTM_ORIGIN_ENV, type GtmOverrideInput } from '@pingwright/recorder';
import type { Network, SuiteArgs } from './args.ts';
import { executeRun, readGtmOverride, readTrackerList, resolveNetwork, warnTestGtmOrigin, type Io, type RunOutcome, type RunSpec } from './run.ts';

export type CellStatus = 'pass' | 'warn' | 'fail' | 'error' | 'skipped';

export interface SuiteCell {
  scenario: string;
  variant: string;
  labels: Record<string, string>;
  status: CellStatus;
  exitCode: 0 | 1 | 2;
  /** Set on a `fail` or `warn` cell: how many rules failed and which built-in checks. Names and counts only. */
  failed?: { rules: number; checks: string[] };
  /** File name inside the suite directory. Absent when the run wrote none. */
  record?: string;
}

export interface SuiteDiff {
  scenario: string;
  from: string;
  to: string;
  added: number;
  removed: number;
  changed: number;
  flagsChanged: number;
}

export interface SuiteManifest {
  suiteSchemaVersion: 1;
  id: string;
  startedAt: number;
  site: string;
  variants: string[];
  cells: SuiteCell[];
  diffs: SuiteDiff[];
  exitCode: 0 | 1 | 2;
}

export interface SuiteDeps {
  run: (spec: RunSpec, io: Io) => Promise<RunOutcome>;
}

interface LoadedScenario {
  name: string;
  parsed: Scenario;
  handoff: boolean;
}

const SCENARIO_EXTENSIONS = new Set(['.yml', '.yaml']);

/** Worst first: a run that did not finish (2), a failed expectation or built-in check (1), else 0. A skipped cell counts as 0. */
export function suiteExitCode(cells: Pick<SuiteCell, 'exitCode'>[]): 0 | 1 | 2 {
  return cells.some((c) => c.exitCode === 2) ? 2 : cells.some((c) => c.exitCode === 1) ? 1 : 0;
}

function statusOf(outcome: RunOutcome): CellStatus {
  const summary = outcome.summary;
  if (!summary) return 'error';
  return !summary.ok ? 'fail' : summary.pass ? 'pass' : 'warn';
}

function failedOf(outcome: RunOutcome, status: CellStatus): SuiteCell['failed'] {
  if (status !== 'fail' && status !== 'warn') return undefined;
  const severity = status === 'fail' ? 'fail' : 'warn';
  const checks = new Set<string>();
  let rules = 0;
  for (const r of outcome.summary!.results) {
    if (r.pass || r.severity !== severity) continue;
    const name = /^builtin: ([A-Za-z]+)$/.exec(r.expectation)?.[1];
    if (name) checks.add(name);
    else rules++;
  }
  return { rules, checks: [...checks] };
}

/** The text of a cell in the terminal table and in the report. Never a rule's text or a message. */
export function cellText(cell: Pick<SuiteCell, 'status' | 'exitCode' | 'failed'>): string {
  if (cell.status === 'error') return `ERROR (exit ${cell.exitCode})`;
  const label = cell.status.toUpperCase();
  const { rules = 0, checks = [] } = cell.failed ?? {};
  const parts = [rules > 0 && `${rules} rule${rules === 1 ? '' : 's'}`, ...checks].filter(Boolean);
  return parts.length ? `${label}: ${parts.join(', ')}` : label;
}

function diffText(d: SuiteDiff | undefined): string {
  if (!d) return '';
  const parts = [
    d.added && `+${d.added} added`,
    d.removed && `-${d.removed} removed`,
    d.changed && `${d.changed} changed`,
    d.flagsChanged && `${d.flagsChanged} flag change${d.flagsChanged === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no change';
}

export function formatSuiteTable(manifest: SuiteManifest, dir: string): string {
  const [first, ...others] = manifest.variants;
  const scenarios = [...new Set(manifest.cells.map((c) => c.scenario))];
  const header = ['scenario', ...manifest.variants, ...others.map((v) => `diff (${first} -> ${v})`)];
  const rows = scenarios.map((scenario) => [
    scenario,
    ...manifest.variants.map((v) => cellText(manifest.cells.find((c) => c.scenario === scenario && c.variant === v)!)),
    ...others.map((v) => diffText(manifest.diffs.find((d) => d.scenario === scenario && d.to === v))),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]! + 3))).join('').trimEnd();
  const out = [line(header), ...rows.map(line)];
  const records = manifest.cells.filter((c) => c.record);
  if (records.length) out.push('', 'Records', ...records.map((c) => `  ${c.scenario} ${c.variant}: ${join(dir, c.record!)}`));
  const unfinished = manifest.cells.filter((c) => c.exitCode === 2);
  if (unfinished.length) {
    out.push('', 'Errors', ...unfinished.map((c) => `  ${c.scenario} ${c.variant}: run did not finish (exit 2), ${c.record ? `details in ${join(dir, c.record)}` : 'details in the stderr above'}`));
  }
  out.push('', `Manifest: ${join(dir, 'suite.json')}`);
  return `${out.join('\n')}\n`;
}

async function scan(dir: string, trackers: TrackerEntry[], io: Io): Promise<LoadedScenario[] | undefined> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries.filter((e) => e.isFile() && SCENARIO_EXTENSIONS.has(extname(e.name))).map((e) => e.name).sort();
  } catch (error) {
    io.stderr(`Cannot read ${dir}: ${error instanceof Error ? (error as NodeJS.ErrnoException).code : 'unknown error'}\n`);
    return undefined;
  }
  if (!names.length) {
    io.stderr(`${dir} has no .yml or .yaml scenario files\n`);
    return undefined;
  }
  const loaded: LoadedScenario[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of names) {
    const name = basename(file, extname(file));
    if (seen.has(name)) problems.push(`${file}: another file has the scenario name "${name}"`);
    seen.add(name);
    try {
      const parsed = parseScenario(await readFile(join(dir, file), 'utf8'), trackers.map((t) => t.vendor));
      for (const warning of parsed.warnings) io.stderr(`Warning: ${file}: ${warning}\n`);
      loaded.push({ name, parsed, handoff: hasHandoff(parsed) });
    } catch (error) {
      if (!(error instanceof ScenarioError)) throw error;
      problems.push(`${file} is not a valid scenario:\n${error.issues.map((i) => `    ${i}`).join('\n')}`);
    }
  }
  if (problems.length) {
    io.stderr(`${problems.map((p) => `  ${p}`).join('\n')}\n`);
    return undefined;
  }
  return loaded;
}

async function readOverrides(args: SuiteArgs, io: Io): Promise<Map<string, GtmOverrideInput> | undefined> {
  const overrides = new Map<string, GtmOverrideInput>();
  try {
    parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    for (const variant of args.variants) {
      if (variant.file !== undefined) overrides.set(variant.name, await readGtmOverride(variant.file, `the override file of variant "${variant.name}"`));
    }
  } catch (error) {
    if (!(error instanceof GtmOverrideError)) throw error;
    io.stderr(`${error.message}\n`);
    return undefined;
  }
  return overrides;
}

async function diffPairs(cells: SuiteCell[], variants: string[], dir: string): Promise<SuiteDiff[]> {
  const diffs: SuiteDiff[] = [];
  const [first, ...others] = variants;
  const recordOf = (scenario: string, variant: string) => cells.find((c) => c.scenario === scenario && c.variant === variant)?.record;
  for (const scenario of [...new Set(cells.map((c) => c.scenario))]) {
    const from = recordOf(scenario, first!);
    if (!from) continue;
    const a = await readRun(join(dir, from));
    for (const to of others) {
      const record = recordOf(scenario, to);
      if (!record) continue;
      const result = diffRuns(a, await readRun(join(dir, record)));
      diffs.push({
        scenario,
        from: first!,
        to,
        added: result.added.length,
        removed: result.removed.length,
        changed: result.changed.length,
        flagsChanged: result.flags.filter((f) => !f.allowed).length,
      });
    }
  }
  return diffs;
}

function applyVars(scenarios: LoadedScenario[], vars: Record<string, string>): string[] {
  const used = new Set<string>();
  for (const s of scenarios) {
    const declared = Object.entries(vars).filter(([name]) => Object.hasOwn(s.parsed.vars, name));
    for (const [name] of declared) used.add(name);
    s.parsed.vars = { ...s.parsed.vars, ...Object.fromEntries(declared) };
  }
  return Object.keys(vars).filter((name) => !used.has(name));
}

export async function suiteCommand(args: SuiteArgs, io: Io, deps: SuiteDeps = { run: executeRun }): Promise<number> {
  let trackers: TrackerEntry[] = [];
  if (args.trackerList !== undefined) {
    try {
      trackers = await readTrackerList(args.trackerList);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const scenarios = await scan(args.dir, trackers, io);
  if (!scenarios) return 2;

  const undeclared = applyVars(scenarios, args.vars);
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(', ')} not declared in the vars of any scenario. --var only overrides declared variables.\n`);
    return 2;
  }

  const networks = new Map<string, Network>();
  for (const s of scenarios) {
    const network = resolveNetwork({ network: args.network, netLog: false }, s.parsed, io);
    if (!network) return 2;
    networks.set(s.name, network);
  }
  const overrides = await readOverrides(args, io);
  if (!overrides) return 2;
  warnTestGtmOrigin(io);

  const id = `suite_${ulid()}`;
  const dir = join(args.out, id);
  await mkdir(dir, { recursive: true });
  const startedAt = Date.now();
  const variants = args.variants.map((v) => v.name);
  const cells: SuiteCell[] = [];

  const ordered = [...scenarios.filter((s) => !s.handoff), ...scenarios.filter((s) => s.handoff)];
  for (const s of ordered) {
    const seed = args.seed ?? s.parsed.options.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (const variant of variants) {
      const cell = { scenario: s.name, variant, labels: {} };
      if (s.handoff && !args.withHandoff) {
        cells.push({ ...cell, status: 'skipped', exitCode: 0 });
        continue;
      }
      io.stderr(`Running ${s.name} (${variant})\n`);
      const outcome = await deps.run(
        {
          parsed: s.parsed,
          scenarioName: s.name,
          network: networks.get(s.name)!,
          site: args.site,
          out: dir,
          seed,
          headed: false,
          netLog: false,
          autoconsentRules: args.autoconsentRules,
          trackers,
          gtmOverride: overrides.get(variant),
          variant: { name: variant, fileStem: s.name },
        },
        io,
      );
      const status = statusOf(outcome);
      const failed = failedOf(outcome, status);
      cells.push({ ...cell, status, exitCode: outcome.code, ...(failed && { failed }), ...(outcome.path && { record: basename(outcome.path) }) });
    }
  }
  const position = (c: SuiteCell) => scenarios.findIndex((s) => s.name === c.scenario) * variants.length + variants.indexOf(c.variant);
  cells.sort((a, b) => position(a) - position(b));

  const manifest: SuiteManifest = {
    suiteSchemaVersion: 1,
    id,
    startedAt,
    site: new URL(args.site).origin,
    variants,
    cells,
    diffs: await diffPairs(cells, variants, dir),
    exitCode: suiteExitCode(cells),
  };
  await writeFile(join(dir, 'suite.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  io.stdout(args.json ? `${JSON.stringify(manifest, null, 2)}\n` : formatSuiteTable(manifest, dir));
  return manifest.exitCode;
}
