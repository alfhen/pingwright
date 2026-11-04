import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { readRun, ulid } from '@tagreeve/core';
import type { TrackerEntry } from '@tagreeve/decoders';
import { diffRuns, mergeOptions, parseScenario, ScenarioError, type Scenario, type ScenarioOptions } from '@tagreeve/expect';
import { GtmOverrideError, hasHandoff, hasPayment, normalizeHost, parseTestGtmOrigin, TEST_GTM_ORIGIN_ENV, type GtmOverrideInput, type TestPayment } from '@tagreeve/recorder';
import type { Network, SuiteArgs } from './args.ts';
import { baselineFileName, BaselineError, compareBaseline, readBaseline, type BaselineFile } from './baseline.ts';
import { DEFAULT_BASELINES, DEFAULT_STORES, defaultScenarioDir, defaultStores, resolveAutoconsentRules, resolveTrackerList, type DefaultUsed } from './defaults.ts';
import { warnIfNotIgnored } from './git-ignore.ts';
import { oldRunsNotice, resolveOutDir } from './out-dir.ts';
import { formatDefaults, type DefaultEntry } from './project-config.ts';
import { readStores, StoresError, type Store } from './stores.ts';
import { checkTestPaymentGates } from './test-payment-hosts.ts';
import { executeRun, loadConfigOrReport, prepareServerContainer, readGtmOverride, readTrackerList, resolveNetwork, warnTestGtmOrigin, warnTestLoopbackHosted, type Io, type RunOutcome, type RunSpec } from './run.ts';

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
  /** Set with `--baseline` on a cell that ran and wrote a record. Names and counts only. */
  baseline?: CellBaseline;
}

export interface CellBaseline {
  /** The baseline file name, without its folder. */
  file: string;
  drift: boolean;
  added: number;
  removed: number;
  countChanges: number;
}

export interface SuiteStore {
  name: string;
  /** Origin only. */
  site: string;
}

export interface SuiteDiff {
  scenario: string;
  /** Set with `--stores`. */
  store?: string;
  from: string;
  to: string;
  added: number;
  removed: number;
  changed: number;
  flagsChanged: number;
}

export interface SuiteManifest {
  suiteSchemaVersion: 1 | 2 | 3;
  id: string;
  /** From `--label`. */
  label?: string;
  startedAt: number;
  site: string;
  /** Empty without `--stores`, and in a version 1 manifest. */
  stores: SuiteStore[];
  variants: string[];
  cells: SuiteCell[];
  diffs: SuiteDiff[];
  exitCode: 0 | 1 | 2;
  /** Files used because their flag was not given. Absent when none. */
  defaults?: DefaultEntry[];
}

export interface SuiteDeps {
  run: (spec: RunSpec, io: Io) => Promise<RunOutcome>;
}

interface LoadedScenario {
  name: string;
  parsed: Scenario;
  handoff: boolean;
  payment: boolean;
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
export function cellText(cell: Pick<SuiteCell, 'status' | 'exitCode' | 'failed'> & { baseline?: Pick<CellBaseline, 'drift'> }): string {
  if (cell.status === 'error') return `ERROR (exit ${cell.exitCode})`;
  const label = cell.status.toUpperCase();
  const { rules = 0, checks = [] } = cell.failed ?? {};
  const drift = cell.baseline?.drift === true;
  const parts = [rules > 0 && `${rules} rule${rules === 1 ? '' : 's'}`, ...checks, drift && 'baseline drift'].filter(Boolean);
  if (drift && parts.length === 1) return `${label} (baseline drift)`;
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

/** The cell's name in lists: scenario, store when there is one, variant. */
export function cellName(cell: Pick<SuiteCell, 'scenario' | 'variant' | 'labels'>): string {
  return [cell.scenario, cell.labels.store, cell.variant].filter(Boolean).join(' ');
}

export function formatSuiteTable(manifest: SuiteManifest, dir: string): string {
  const [first, ...others] = manifest.variants;
  const scenarios = [...new Set(manifest.cells.map((c) => c.scenario))];
  const stores = manifest.stores.map((s) => s.name);
  const header = ['scenario', ...(stores.length ? ['store'] : []), ...manifest.variants, ...others.map((v) => `diff (${first} -> ${v})`)];
  const rows = scenarios.flatMap((scenario) =>
    (stores.length ? stores : [undefined]).map((store) => [
      scenario,
      ...(store === undefined ? [] : [store]),
      ...manifest.variants.map((v) => cellText(manifest.cells.find((c) => c.scenario === scenario && c.labels.store === store && c.variant === v)!)),
      ...others.map((v) => diffText(manifest.diffs.find((d) => d.scenario === scenario && d.store === store && d.to === v))),
    ]),
  );
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cols: string[]) => cols.map((c, i) => (i === cols.length - 1 ? c : c.padEnd(widths[i]! + 3))).join('').trimEnd();
  const out = [line(header), ...rows.map(line)];
  const defaultsLine = formatDefaults(manifest.defaults);
  if (defaultsLine) out.push('', defaultsLine);
  const records = manifest.cells.filter((c) => c.record);
  if (records.length) out.push('', 'Records', ...records.map((c) => `  ${cellName(c)}: ${join(dir, c.record!)}`));
  const drifted = manifest.cells.filter((c) => c.baseline?.drift);
  if (drifted.length) {
    out.push('', 'Baseline drift', ...drifted.map((c) => `  ${cellName(c)}: ${c.baseline!.file}: ${c.baseline!.added} added, ${c.baseline!.removed} removed, ${c.baseline!.countChanges} count changes`));
  }
  const unfinished = manifest.cells.filter((c) => c.exitCode === 2);
  if (unfinished.length) {
    out.push('', 'Errors', ...unfinished.map((c) => `  ${cellName(c)}: run did not finish (exit 2), ${c.record ? `details in ${join(dir, c.record)}` : 'details in the stderr above'}`));
  }
  out.push('', `Manifest: ${join(dir, 'suite.json')}`);
  return `${out.join('\n')}\n`;
}

async function scan(dir: string, trackers: TrackerEntry[], configOptions: ScenarioOptions, io: Io): Promise<LoadedScenario[] | undefined> {
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
      parsed.options = mergeOptions(configOptions, parsed.options);
      for (const warning of parsed.warnings) io.stderr(`Warning: ${file}: ${warning}\n`);
      loaded.push({ name, parsed, handoff: hasHandoff(parsed), payment: hasPayment(parsed) });
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

async function diffPairs(cells: SuiteCell[], variants: string[], stores: string[], dir: string): Promise<SuiteDiff[]> {
  const diffs: SuiteDiff[] = [];
  const [first, ...others] = variants;
  const recordOf = (scenario: string, store: string | undefined, variant: string) =>
    cells.find((c) => c.scenario === scenario && c.labels.store === store && c.variant === variant)?.record;
  for (const scenario of [...new Set(cells.map((c) => c.scenario))]) {
    for (const store of stores.length ? stores : [undefined]) {
      const from = recordOf(scenario, store, first!);
      if (!from) continue;
      const a = await readRun(join(dir, from));
      for (const to of others) {
        const record = recordOf(scenario, store, to);
        if (!record) continue;
        const result = diffRuns(a, await readRun(join(dir, record)));
        diffs.push({
          scenario,
          ...(store !== undefined && { store }),
          from: first!,
          to,
          added: result.added.length,
          removed: result.removed.length,
          changed: result.changed.length,
          flagsChanged: result.flags.filter((f) => !f.allowed).length,
        });
      }
    }
  }
  return diffs;
}

function undeclaredVars(scenarios: LoadedScenario[], vars: Record<string, string>): string[] {
  return Object.keys(vars).filter((name) => !scenarios.some((s) => Object.hasOwn(s.parsed.vars, name)));
}

/** Scenario vars, then the store's, then `--var`. A var the scenario does not declare is left out. */
function scenarioFor(s: LoadedScenario, store: Store | undefined, argVars: Record<string, string>, io: Io): Scenario {
  const overrides = { ...store?.vars, ...argVars };
  const declared = Object.fromEntries(Object.entries(overrides).filter(([name]) => Object.hasOwn(s.parsed.vars, name)));
  const identity = { ...s.parsed.identity };
  if (store?.country !== undefined) {
    if (identity.country !== undefined && identity.country !== store.country) {
      io.stderr(`Warning: ${s.name}: identity.country differs from the country of store "${store.name}". The store's country is used.\n`);
    }
    identity.country = store.country;
  }
  return { ...s.parsed, vars: { ...s.parsed.vars, ...declared }, identity };
}

async function loadStores(path: string | undefined, io: Io): Promise<Store[] | undefined> {
  if (path === undefined) return [];
  try {
    return await readStores(path);
  } catch (error) {
    if (!(error instanceof StoresError)) throw error;
    io.stderr(`${error.message}\n`);
    return undefined;
  }
}

export async function suiteCommand(args: SuiteArgs, io: Io, deps: SuiteDeps = { run: executeRun }): Promise<number> {
  if (args.allowTestPayment !== undefined && args.site === undefined && args.stores === undefined) {
    io.stderr('--allow-test-payment needs --site or --stores on the command line. A default file never supplies the host a test payment runs on.\n');
    return 2;
  }
  const config = await loadConfigOrReport(args.config, io);
  if (!config.ok) return 2;
  const loaded = config.loaded;
  const defaults: DefaultUsed[] = [];
  const scenarioDir = args.dir ?? (await defaultScenarioDir(defaults));
  if (scenarioDir === undefined) {
    io.stderr('suite needs a scenario folder: give <dir> or create tagreeve/scenarios.\n');
    return 2;
  }
  const trackerListPath = await resolveTrackerList(args.trackerList, defaults);
  const autoconsentRules = await resolveAutoconsentRules(args.autoconsentRules, defaults);
  let trackers: TrackerEntry[] = [];
  if (trackerListPath !== undefined) {
    try {
      trackers = await readTrackerList(trackerListPath);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  const configSite = args.site === undefined && args.stores === undefined ? loaded?.config.site : undefined;
  const site = args.site ?? configSite;
  let storesPath: string | undefined;
  if (site === undefined) {
    storesPath = args.stores ?? (await defaultStores(defaults));
  } else if (configSite !== undefined && (await defaultStores([])) !== undefined) {
    io.stderr(`${loaded!.path} sets site and ${DEFAULT_STORES} exists. Give --site or --stores to say which one to use.\n`);
    return 2;
  }
  if (site === undefined && storesPath === undefined) {
    io.stderr('suite needs a site: give --site or --stores, or create tagreeve/stores.json.\n');
    return 2;
  }
  const stores = await loadStores(storesPath, io);
  if (!stores) return 2;
  const scenarios = await scan(scenarioDir, trackers, loaded?.config.options ?? {}, io);
  if (!scenarios) return 2;

  const undeclared = undeclaredVars(scenarios, args.vars);
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(', ')} not declared in the vars of any scenario. --var only overrides declared variables.\n`);
    return 2;
  }
  for (const store of stores) {
    const missing = undeclaredVars(scenarios, store.vars);
    if (missing.length) {
      io.stderr(`Store "${store.name}": var ${missing.join(', ')} not declared in the vars of any scenario. Store vars only override declared variables.\n`);
      return 2;
    }
  }

  const networks = new Map<string, Network>();
  for (const s of scenarios) {
    const network = resolveNetwork({ network: args.network, netLog: false, serverContainer: args.serverContainer }, s.parsed, io, loaded?.path);
    if (!network) return 2;
    networks.set(s.name, network);
  }
  const serverHosts = [...new Set(scenarios.flatMap((s) => s.parsed.options.serverHosts ?? []))];
  const serverContainer = await prepareServerContainer(args, serverHosts, io);
  if (serverContainer === undefined) return 2;
  const overrides = await readOverrides(args, io);
  if (!overrides) return 2;
  warnTestGtmOrigin(io);
  warnTestLoopbackHosted(io);
  if (args.out === undefined && loaded?.config.out === undefined) {
    const notice = await oldRunsNotice(process.cwd());
    if (notice) io.stderr(notice);
  }

  const targets: { store: Store | undefined; site: string }[] = stores.length ? stores.map((store) => ({ store, site: store.site })) : [{ store: undefined, site: site! }];
  const allowedHost = args.allowTestPayment === undefined ? undefined : normalizeHost(args.allowTestPayment);
  const paymentKey = (scenario: string, store: Store | undefined) => JSON.stringify([scenario, store?.name]);
  const testPayments = new Map<string, TestPayment>();
  if (args.withTestPayment && args.allowTestPayment !== undefined) {
    if (stores.length && scenarios.some((x) => x.payment) && !targets.some((t) => normalizeHost(new URL(t.site).hostname) === allowedHost)) {
      io.stderr(`--allow-test-payment ${allowedHost}: no store in the stores file has that host.\n`);
      return 2;
    }
    for (const s of scenarios.filter((x) => x.payment)) {
      for (const { store, site } of targets) {
        if (store && normalizeHost(new URL(site).hostname) !== allowedHost) continue;
        const gates = await checkTestPaymentGates(s.parsed, site, args.allowTestPayment);
        if (!gates.ok) {
          io.stderr(`${s.name}${store ? ` on ${store.name}` : ''}: ${gates.error}\n`);
          return 2;
        }
        if (gates.testPayment) testPayments.set(paymentKey(s.name, store), gates.testPayment);
      }
    }
  }

  const baselineDir = args.baseline ?? (args.baselineDefault ? DEFAULT_BASELINES : undefined);
  if (args.baselineDefault) defaults.push({ setting: 'baseline', path: DEFAULT_BASELINES });
  const baselines = new Map<string, BaselineFile>();
  const baselineFor = (scenario: string, store: Store | undefined, variant: string) => baselineFileName(scenario, store?.name, variant);
  if (baselineDir !== undefined) {
    const missing: string[] = [];
    const unreadable: string[] = [];
    for (const s of scenarios) {
      for (const { store } of targets) {
        if ((s.handoff && !args.withHandoff) || (s.payment && !testPayments.has(paymentKey(s.name, store)))) continue;
        for (const variant of args.variants.map((v) => v.name)) {
          const file = baselineFor(s.name, store, variant);
          if (baselines.has(file) || missing.includes(join(baselineDir, file))) continue;
          try {
            baselines.set(file, await readBaseline(join(baselineDir, file)));
          } catch (error) {
            if (!(error instanceof BaselineError)) throw error;
            (error.message.includes('ENOENT') ? missing : unreadable).push(error.message.includes('ENOENT') ? join(baselineDir, file) : error.message);
          }
        }
      }
    }
    if (missing.length || unreadable.length) {
      io.stderr(`${[...(missing.length ? ['Baseline files missing:', ...missing.map((m) => `  ${m}`)] : []), ...unreadable].join('\n')}\nSave them with "tagreeve baseline save <record>", or run the suite without --baseline.\n`);
      return 2;
    }
  }

  const id = `suite_${ulid()}`;
  const outFolder = resolveOutDir({ out: args.out, now: new Date(), label: args.label, base: loaded?.config.out });
  await warnIfNotIgnored(outFolder, io.stderr);
  const dir = join(outFolder, id);
  await mkdir(dir, { recursive: true });
  const startedAt = Date.now();
  const variants = args.variants.map((v) => v.name);
  const cells: SuiteCell[] = [];

  const ordered = [...scenarios.filter((s) => !s.handoff), ...scenarios.filter((s) => s.handoff)];
  for (const s of ordered) {
    const seed = args.seed ?? s.parsed.options.seed ?? Math.floor(Math.random() * 2 ** 31);
    for (const { store, site } of targets) {
      const key = paymentKey(s.name, store);
      const parsed = scenarioFor(s, store, args.vars, io);
      for (const variant of variants) {
        const cell = { scenario: s.name, variant, labels: (store ? { store: store.name } : {}) as Record<string, string> };
        if (s.handoff && !args.withHandoff) {
          cells.push({ ...cell, status: 'skipped', exitCode: 0 });
          continue;
        }
        if (s.payment && !testPayments.has(key)) {
          cells.push({ ...cell, status: 'skipped', exitCode: 0 });
          continue;
        }
        io.stderr(`Running ${s.name}${store ? ` on ${store.name}` : ''} (${variant})\n`);
        const outcome = await deps.run(
          {
            parsed,
            scenarioName: s.name,
            network: networks.get(s.name)!,
            site,
            out: dir,
            ...(args.label !== undefined && { label: args.label }),
            ...(store && { store: store.name }),
            seed,
            headed: false,
            viewport: args.viewport,
            netLog: false,
            autoconsentRules: [...autoconsentRules,...(store?.autoconsentRules ? [store.autoconsentRules] : [])],
            trackers,
            gtmOverride: overrides.get(variant),
            ...(serverContainer && { serverContainer }),
            ...(testPayments.has(key) && { testPayment: testPayments.get(key)! }),
            variant: { name: variant, fileStem: store ? `${s.name}.${store.name}` : s.name },
          },
          io,
        );
        let status = statusOf(outcome);
        let failed = failedOf(outcome, status);
        let exitCode = outcome.code;
        let compared: CellBaseline | undefined;
        const expected = baselines.get(baselineFor(s.name, store, variant));
        if (expected && outcome.path) {
          const result = compareBaseline(expected, await readRun(outcome.path));
          for (const warning of result.warnings) io.stderr(`Warning: ${cellName(cell)}: ${warning}\n`);
          compared = { file: baselineFor(s.name, store, variant), drift: result.drift, added: result.added, removed: result.removed, countChanges: result.countChanges };
          if (result.drift && status !== 'error') {
            if (status === 'warn') failed = undefined;
            status = 'fail';
            if (exitCode === 0) exitCode = 1;
          }
        }
        cells.push({ ...cell, status, exitCode, ...(failed && { failed }), ...(outcome.path && { record: basename(outcome.path) }), ...(compared && { baseline: compared }) });
      }
    }
  }
  const storeNames = stores.map((st) => st.name);
  const position = (c: SuiteCell) =>
    (scenarios.findIndex((s) => s.name === c.scenario) * Math.max(storeNames.length, 1) + Math.max(storeNames.indexOf(c.labels.store ?? ''), 0)) * variants.length + variants.indexOf(c.variant);
  cells.sort((a, b) => position(a) - position(b));

  const listed: DefaultEntry[] = [...(loaded?.defaultUsed ? [loaded.defaultUsed] : []), ...defaults];
  const manifest: SuiteManifest = {
    suiteSchemaVersion: 3,
    id,
    ...(args.label !== undefined && { label: args.label }),
    startedAt,
    site: new URL(targets[0]!.site).origin,
    stores: stores.map((st) => ({ name: st.name, site: new URL(st.site).origin })),
    variants,
    cells,
    diffs: await diffPairs(cells, variants, storeNames, dir),
    exitCode: suiteExitCode(cells),
    ...(listed.length > 0 && { defaults: listed }),
  };
  await writeFile(join(dir, 'suite.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  io.stdout(args.json ? `${JSON.stringify(manifest, null, 2)}\n` : formatSuiteTable(manifest, dir));
  return manifest.exitCode;
}
