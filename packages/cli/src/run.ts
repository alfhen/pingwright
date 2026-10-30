import { appendFile, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { PingwrightRecord, Result, RunRecords } from '@pingwright/core';
import { evaluate, parseScenario, ScenarioError } from '@pingwright/expect';
import { recordScenario, StepError } from '@pingwright/recorder';
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

export async function runCommand(args: RunArgs, io: Io): Promise<number> {
  let text: string;
  try {
    text = await readFile(args.scenario, 'utf8');
  } catch (error) {
    io.stderr(`Cannot read ${args.scenario}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseScenario(text);
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
      userAgentOverride: process.env.PINGWRIGHT_TEST_USER_AGENT || undefined,
    });
    records = result.records;
    path = result.path;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (MISSING_BROWSER.test(message)) {
      io.stderr('Chromium is not installed. Run `pingwright install-browser`.\n');
    } else {
      io.stderr(`Run failed: ${message}\n`);
      if (error instanceof StepError && error.run) io.stderr(`Record: ${error.run.path}\n`);
    }
    return 2;
  }

  const results: Result[] = evaluate(allRecords(records), parsed);
  await appendFile(path, results.map((r) => JSON.stringify(r) + '\n').join(''));
  const summary = buildSummary(records, results, path);
  io.stdout(args.json ? `${JSON.stringify(summary, null, 2)}\n` : `${formatSummary(summary)}\n`);
  return exitCodeFor(results);
}
