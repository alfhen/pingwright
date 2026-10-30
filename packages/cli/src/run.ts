import { appendFile, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PingwrightRecord, Result, RunRecords } from '@pingwright/core';
import { parseTrackerList, type TrackerEntry } from '@pingwright/decoders';
import { evaluate, parseScenario, ScenarioError } from '@pingwright/expect';
import {
  GtmOverrideError,
  GtmOverrideFailure,
  parseGtmOverride,
  parseTestGtmOrigin,
  recordScenario,
  Scrubber,
  StepError,
  TEST_GTM_ORIGIN_ENV,
  type GtmOverrideInput,
} from '@pingwright/recorder';
import type { RunArgs } from './args.ts';
import { buildSummary, exitCodeFor, formatSummary } from './summary.ts';

export interface Io {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const MISSING_BROWSER = /Executable doesn't exist|playwright install/i;

function allRecords(records: RunRecords): PingwrightRecord[] {
  const { run, truncatedAtLine, ...rest } = records;
  void truncatedAtLine;
  return [run, ...Object.values(rest).flat()];
}

async function readGtmOverride(path: string): Promise<GtmOverrideInput> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new GtmOverrideError(`Cannot read ${path}: ${error instanceof Error ? (error as NodeJS.ErrnoException).code : 'unknown error'}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // The parser's message can quote the file, which holds the auth value.
    throw new GtmOverrideError(`${path} is not valid JSON`);
  }
  return parseGtmOverride(json);
}

async function readTrackerList(path: string): Promise<TrackerEntry[]> {
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

export async function runCommand(args: RunArgs, rawIo: Io): Promise<number> {
  let io = rawIo;
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

  const networkMode = args.network ?? parsed.options.network ?? 'stub';
  if (networkMode === 'server') {
    io.stderr('Network mode "server" is not available yet. Use stub or live.\n');
    return 2;
  }
  if (networkMode === 'live') io.stderr('Warning: live mode. Hits reach real vendor accounts.\n');

  let testGtmOrigin: string | undefined;
  let gtmOverride: GtmOverrideInput | undefined;
  try {
    testGtmOrigin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    if (args.gtmOverride !== undefined) gtmOverride = await readGtmOverride(args.gtmOverride);
  } catch (error) {
    if (!(error instanceof GtmOverrideError)) throw error;
    io.stderr(`${error.message}\n`);
    return 2;
  }
  if (testGtmOrigin) {
    io.stderr(`Warning: ${TEST_GTM_ORIGIN_ENV} is set. gtm.js is fetched from ${testGtmOrigin}. This is for tests only.\n`);
  }
  if (gtmOverride) {
    const scrubber = new Scrubber(gtmOverride.gtmAuth);
    io = { stdout: (t) => rawIo.stdout(scrubber.text(t)), stderr: (t) => rawIo.stderr(scrubber.text(t)) };
  }

  let records: RunRecords;
  let path: string;
  try {
    const result = await recordScenario({
      networkMode,
      outDir: args.out,
      site: args.site,
      scenario: basename(args.scenario),
      parsed,
      firstPartyHosts: parsed.options.firstPartyHosts,
      seed: args.seed,
      headed: args.headed,
      autoconsent: args.autoconsentRules.length ? { ruleFiles: args.autoconsentRules } : undefined,
      gtmOverride,
      trackerList: trackers,
      userAgentOverride: process.env.PINGWRIGHT_TEST_USER_AGENT || undefined,
    });
    records = result.records;
    path = result.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_BROWSER.test(message)) {
      io.stderr('Chromium is not installed. Run `pingwright install-browser`.\n');
    } else {
      io.stderr(`Run failed: ${error instanceof GtmOverrideFailure ? `GTM override: ${message}` : message}\n`);
      if ((error instanceof StepError || error instanceof GtmOverrideFailure) && error.run) io.stderr(`Record: ${error.run.path}\n`);
    }
    return 2;
  }

  const results: Result[] = evaluate(allRecords(records), parsed);
  await appendFile(path, results.map((r) => JSON.stringify(r) + '\n').join(''));
  const summary = buildSummary(records, results, path);
  io.stdout(args.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatSummary(summary)}\n`);
  return exitCodeFor(results);
}
