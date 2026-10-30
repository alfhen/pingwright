import { parseArgs } from 'node:util';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface RunArgs {
  command: 'run';
  scenario: string;
  site: string;
  network: 'stub' | 'live' | undefined;
  out: string;
  seed: number | undefined;
  headed: boolean;
  netLog: boolean;
  autoconsentRules: string[];
  gtmOverride: string | undefined;
  trackerList: string | undefined;
  vars: Record<string, string>;
  json: boolean;
}

export interface DiffArgs {
  command: 'diff';
  a: string;
  b: string;
  byPage: boolean;
  json: boolean;
}

export type Command = RunArgs | DiffArgs | { command: 'install-browser' } | { command: 'version' } | { command: 'help'; topic?: 'run' };

export const USAGE = `Usage:
  pingwright run <scenario.yml> --site <url> [options]
  pingwright diff <a.jsonl> <b.jsonl> [--by-page] [--json]
  pingwright install-browser
  pingwright --version

Run "pingwright run --help" for the options of run.

Options for run:
  --site <url>               The site to test (required)
  --network stub|live        stub (default) answers tracking requests locally; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --net-log                  Capture requests a frame sends while it unloads, from Chromium's net log
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
`;

export const RUN_USAGE = `Usage: pingwright run <scenario.yml> --site <url> [options]

Plays the scenario in Chromium, records every request, checks the expectations
and writes one JSONL record.

Options:
  --site <url>               The site to test (required)
  --network stub|live        stub (default) answers tracking requests locally; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --net-log                  Capture requests a frame sends while it unloads, from Chromium's net log
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
  -h, --help                 Show this help

Exit codes: 0 pass, 1 failed expectations, 2 usage or run error.

Scenario format: https://github.com/alfhen/pingwright/blob/main/docs/design.md#11-expectations
`;

export function parseCli(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        site: { type: 'string' },
        network: { type: 'string' },
        out: { type: 'string' },
        seed: { type: 'string' },
        headed: { type: 'boolean' },
        'net-log': { type: 'boolean' },
        'autoconsent-rules': { type: 'string', multiple: true },
        'gtm-override': { type: 'string' },
        'tracker-list': { type: 'string' },
        var: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        'by-page': { type: 'boolean' },
        version: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.version) return { command: 'version' };
  const [command, ...rest] = positionals;
  if (values.help && command === 'run') return { command: 'help', topic: 'run' };
  if (values.help || command === undefined) return { command: 'help' };
  if (command === 'install-browser') {
    if (rest.length) throw new UsageError('install-browser takes no arguments');
    return { command: 'install-browser' };
  }
  if (command === 'diff') {
    if (rest.length !== 2) throw new UsageError('diff takes two JSONL files');
    return { command: 'diff', a: rest[0]!, b: rest[1]!, byPage: values['by-page'] ?? false, json: values.json ?? false };
  }
  if (command !== 'run') throw new UsageError(`Unknown command "${command}"`);

  if (rest.length !== 1) throw new UsageError('run takes one scenario file');
  if (!values.site) throw new UsageError('--site is required');
  try {
    const url = new URL(values.site);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new UsageError(`--site must be an http or https URL, got "${values.site}"`);
  }
  const network = values.network;
  if (network !== undefined && network !== 'stub' && network !== 'live') {
    throw new UsageError(`--network must be stub or live, got "${network}"`);
  }
  let seed: number | undefined;
  if (values.seed !== undefined) {
    seed = Number(values.seed);
    if (!Number.isInteger(seed) || seed < 0) throw new UsageError(`--seed must be a non-negative integer, got "${values.seed}"`);
  }
  const vars: Record<string, string> = {};
  for (const entry of values.var ?? []) {
    const eq = entry.indexOf('=');
    if (eq < 1) throw new UsageError(`--var must look like name=value, got "${entry}"`);
    vars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return {
    command: 'run',
    scenario: rest[0]!,
    site: values.site,
    network,
    out: values.out ?? 'runs',
    seed,
    headed: values.headed ?? false,
    netLog: values['net-log'] ?? false,
    autoconsentRules: values['autoconsent-rules'] ?? [],
    gtmOverride: values['gtm-override'],
    trackerList: values['tracker-list'],
    vars,
    json: values.json ?? false,
  };
}
