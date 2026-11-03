import { appendFile, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { readRun, type TagreeveRecord, type Result, type Run, type RunRecords } from '@tagreeve/core';
import { parseTrackerList, type TrackerEntry } from '@tagreeve/decoders';
import { DEFAULT_GRACE_MS, evaluate, isLoopbackPattern, parseScenario, ScenarioError, type Scenario, type Viewport } from '@tagreeve/expect';
import {
  GtmOverrideError,
  GtmOverrideFailure,
  parseGtmOverride,
  parseTestGtmOrigin,
  recordScenario,
  Scrubber,
  StepError,
  TEST_GTM_ORIGIN_ENV,
  TEST_LOOPBACK_IS_HOSTED_ENV,
  loopbackIsHostedForTests,
  type GtmOverrideInput,
  type TestPayment,
} from '@tagreeve/recorder';
import { BaselineError, compareBaseline, readBaseline, type BaselineFile } from './baseline.ts';
import { NET_LOG_NEEDS_LIVE, type Network, type RunArgs } from './args.ts';
import { applyBaseline, buildSummary, exitCodeFor, formatSummary, type Summary } from './summary.ts';
import { acceptsDeclaration, checkTestPaymentGates, testPaymentHostsPath } from './test-payment-hosts.ts';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const MISSING_BROWSER = /Executable doesn't exist|playwright install/i;

function allRecords(records: RunRecords): TagreeveRecord[] {
  const { run, truncatedAtLine, ...rest } = records;
  void truncatedAtLine;
  return [run, ...Object.values(rest).flat()];
}

export async function readGtmOverride(path: string, label: string = path): Promise<GtmOverrideInput> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new GtmOverrideError(`Cannot read ${label}: ${error instanceof Error ? (error as NodeJS.ErrnoException).code : 'unknown error'}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // The parser's message can quote the file, which holds the auth value.
    throw new GtmOverrideError(`${label} is not valid JSON`);
  }
  return parseGtmOverride(json);
}

export async function readTrackerList(path: string): Promise<TrackerEntry[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  try {
    return parseTrackerList(json);
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface RunSpec {
  parsed: Scenario;
  /** Written to `Run.scenario`. */
  scenarioName: string;
  network: Network;
  site: string;
  out: string;
  seed: number | undefined;
  headed: boolean;
  /** From `--viewport`. It wins over `options.viewport`. */
  viewport?: Viewport;
  netLog: boolean;
  autoconsentRules: string[];
  trackers: TrackerEntry[];
  gtmOverride: GtmOverrideInput | undefined;
  /** Set once the allow flag and the allowlist file have passed. */
  testPayment?: TestPayment;
  /** Set by `suite`: stored on the record, which is renamed to `<fileStem>.<variant>.jsonl` in `out`. */
  variant?: { name: string; fileStem: string };
}

export interface RunOutcome {
  /** 0 pass, 1 an expectation or built-in check failed, 2 the run did not finish. */
  code: 0 | 1 | 2;
  path?: string;
  summary?: Summary;
  /** Set when code is 2. Already scrubbed. */
  error?: string;
}

/** Applies the network rules shared by `run` and `suite`. Returns undefined after writing the reason to stderr. */
export function resolveNetwork(args: Pick<RunArgs, 'network' | 'netLog'>, parsed: Scenario, io: Io): Network | undefined {
  const networkMode = args.network ?? parsed.options.network ?? 'stub';
  const serverHosts = parsed.options.serverHosts ?? [];
  if (networkMode === 'server') {
    if (serverHosts.length === 0) {
      io.stderr('Network mode "server" needs options.serverHosts in the scenario: the hosts whose requests pass through, such as sgtm.example.com.\n');
      return undefined;
    }
    const hosted = serverHosts.filter((host) => !isLoopbackPattern(host));
    if (hosted.length) io.stderr(`Warning: server mode. Requests to ${hosted.join(', ')} reach the network.\n`);
  }
  if (args.netLog && networkMode !== 'live') {
    io.stderr(`${NET_LOG_NEEDS_LIVE}\n`);
    return undefined;
  }
  if (networkMode === 'live') io.stderr('Warning: live mode. Hits reach real vendor accounts.\n');
  return networkMode;
}

export function warnTestLoopbackHosted(io: Io): void {
  if (loopbackIsHostedForTests()) {
    io.stderr(`Warning: ${TEST_LOOPBACK_IS_HOSTED_ENV} is set. The fill, select and evaluate guards treat loopback hosts as hosted. This is for tests only.\n`);
  }
}

export function warnTestGtmOrigin(io: Io): void {
  const origin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
  if (origin) io.stderr(`Warning: ${TEST_GTM_ORIGIN_ENV} is set. gtm.js is fetched from ${origin}. This is for tests only.\n`);
}

async function labelRecord(path: string, variant: NonNullable<RunSpec['variant']>, out: string): Promise<string> {
  const text = await readFile(path, 'utf8');
  const newline = text.indexOf('\n');
  const run = { ...(JSON.parse(text.slice(0, newline)) as Run), variant: variant.name };
  const target = join(out, `${variant.fileStem}.${variant.name}.jsonl`);
  await writeFile(path, `${JSON.stringify(run)}${text.slice(newline)}`);
  await rename(path, target);
  return target;
}

function markerNotDetected(message: string): boolean {
  return /test mode not detected(?! \()/.test(message);
}

function declarationHint(spec: RunSpec, label: string | undefined): string | undefined {
  if (!spec.testPayment) return undefined;
  const payments = spec.parsed.steps.flatMap((s) => (s.kind === 'payment' ? [s] : []));
  const failed = label === undefined ? undefined : payments.find((s) => s.label === label);
  const providers = failed ? [failed.value.provider] : [...new Set(payments.map((s) => s.value.provider))];
  const host = spec.testPayment.host;
  const hints = providers.filter((provider) => acceptsDeclaration(host, provider)).map((provider) => `{ "host": "${host}", "testMode": "${provider}" }`);
  if (hints.length === 0) return undefined;
  return `Declare it in ${testPaymentHostsPath()} with ${hints.join(' or ')} if this store is in test mode.`;
}

export async function executeRun(spec: RunSpec, rawIo: Io): Promise<RunOutcome> {
  const { parsed, gtmOverride, variant } = spec;
  let io = rawIo;
  const scrubber = gtmOverride ? new Scrubber(gtmOverride.gtmAuth) : undefined;
  if (scrubber) {
    io = { stdout: (t) => rawIo.stdout(scrubber.text(t)), stderr: (t) => rawIo.stderr(scrubber.text(t)) };
  }
  const failed = (error: string): RunOutcome => {
    io.stderr(error);
    return { code: 2, error: scrubber ? scrubber.text(error) : error };
  };

  let records: RunRecords;
  let path: string;
  try {
    const result = await recordScenario({
      networkMode: spec.network,
      serverHosts: parsed.options.serverHosts,
      outDir: spec.out,
      site: spec.site,
      scenario: spec.scenarioName,
      parsed,
      firstPartyHosts: parsed.options.firstPartyHosts,
      platformHosts: parsed.options.platformHosts,
      unloadGapIgnore: parsed.options.unloadGapIgnore,
      graceWindowMs: parsed.options.graceWindow ?? DEFAULT_GRACE_MS,
      seed: spec.seed,
      headed: spec.headed,
      viewport: spec.viewport ?? parsed.options.viewport,
      netLog: spec.netLog,
      autoconsent: spec.autoconsentRules.length ? { ruleFiles: spec.autoconsentRules } : undefined,
      gtmOverride,
      warn: (text) => io.stderr(`Warning: ${text}\n`),
      trackerList: spec.trackers,
      ...(spec.testPayment && { testPayment: spec.testPayment }),
      userAgentOverride: process.env.TAGREEVE_TEST_USER_AGENT || undefined,
    });
    records = result.records;
    path = result.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_BROWSER.test(message)) return failed('Chromium is not installed. Run `tagreeve install-browser`.\n');
    let text = `Run failed: ${error instanceof GtmOverrideFailure ? `GTM override: ${message}` : message}\n`;
    const declareHint = spec.testPayment && markerNotDetected(message) && declarationHint(spec, error instanceof StepError ? error.label : undefined);
    if (declareHint) text += `${declareHint}\n`;
    const written = (error instanceof StepError || error instanceof GtmOverrideFailure) && error.run ? error.run.path : undefined;
    if (written) {
      const kept = variant ? await labelRecord(written, variant, spec.out) : written;
      text += `Record: ${kept}\n`;
      return { ...failed(text), path: kept };
    }
    return failed(text);
  }

  if (variant) {
    path = await labelRecord(path, variant, spec.out);
    records.run.variant = variant.name;
  }
  let results: Result[] = evaluate(allRecords(records), parsed);
  if (scrubber) results = scrubber.deep(results);
  await appendFile(path, results.map((r) => JSON.stringify(r) + '\n').join(''));
  return { code: exitCodeFor(results), path, summary: buildSummary(records, results, path) };
}

export async function runCommand(args: RunArgs, io: Io): Promise<number> {
  let text: string;
  try {
    text = await readFile(args.scenario, 'utf8');
  } catch (error) {
    io.stderr(`Cannot read ${args.scenario}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let trackers: TrackerEntry[] = [];
  if (args.trackerList !== undefined) {
    try {
      trackers = await readTrackerList(args.trackerList);
    } catch (error) {
      io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  let parsed;
  try {
    parsed = parseScenario(text, trackers.map((t) => t.vendor));
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
    io.stderr(`${args.scenario} is not a valid scenario:\n${error.issues.map((i) => `  ${i}`).join('\n')}\n`);
    return 2;
  }
  for (const warning of parsed.warnings) io.stderr(`Warning: ${warning}\n`);
  const undeclared = Object.keys(args.vars).filter((name) => !Object.hasOwn(parsed.vars, name));
  if (undeclared.length) {
    io.stderr(`--var ${undeclared.join(', ')} not declared in the scenario's vars. --var only overrides declared variables.\n`);
    return 2;
  }
  parsed.vars = { ...parsed.vars, ...args.vars };

  const network = resolveNetwork(args, parsed, io);
  if (!network) return 2;

  const gates = await checkTestPaymentGates(parsed, args.site, args.allowTestPayment);
  if (!gates.ok) {
    io.stderr(`${gates.error}\n`);
    return 2;
  }

  let baseline: BaselineFile | undefined;
  if (args.baseline !== undefined) {
    try {
      baseline = await readBaseline(args.baseline);
    } catch (error) {
      if (!(error instanceof BaselineError)) throw error;
      io.stderr(`${error.message}\n`);
      return 2;
    }
  }

  let gtmOverride: GtmOverrideInput | undefined;
  try {
    parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    if (args.gtmOverride !== undefined) gtmOverride = await readGtmOverride(args.gtmOverride);
  } catch (error) {
    if (!(error instanceof GtmOverrideError)) throw error;
    io.stderr(`${error.message}\n`);
    return 2;
  }
  warnTestGtmOrigin(io);
  warnTestLoopbackHosted(io);

  const outcome = await executeRun(
    {
      parsed,
      scenarioName: basename(args.scenario),
      network,
      site: args.site,
      out: args.out,
      seed: args.seed,
      headed: args.headed,
      viewport: args.viewport,
      netLog: args.netLog,
      autoconsentRules: args.autoconsentRules,
      trackers,
      gtmOverride,
      ...(gates.testPayment && { testPayment: gates.testPayment }),
    },
    io,
  );
  if (!outcome.summary) return outcome.code;
  let code: 0 | 1 = outcome.code === 1 ? 1 : 0;
  if (baseline && outcome.path) {
    applyBaseline(outcome.summary, compareBaseline(baseline, await readRun(outcome.path)));
    if (outcome.summary.baseline?.drift) code = 1;
  }
  const output = args.json ? `${JSON.stringify(outcome.summary, null, 2)}\n` : `${formatSummary(outcome.summary)}\n`;
  io.stdout(gtmOverride ? new Scrubber(gtmOverride.gtmAuth).text(output) : output);
  return code;
}
