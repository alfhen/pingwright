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
  autoconsentRules: string[];
  vars: Record<string, string>;
  json: boolean;
}

export type Command = RunArgs | { command: 'install-browser' } | { command: 'version' } | { command: 'help'; topic?: 'run' };

export const USAGE = `Usage:
  pingwright run <scenario.yml> --site <url> [options]
  pingwright install-browser
  pingwright --version

Run "pingwright run --help" for the options of run.

Options for run:
  --site <url>               The site to test (required)
  --network stub|live        stub (default) answers tracking requests locally; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
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
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
  -h, --help                 Show this help

Exit codes: 0 pass, 1 failed expectations, 2 usage or run error.
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
        'autoconsent-rules': { type: 'string', multiple: true },
        var: { type: 'string', multiple: true },
        json: { type: 'boolean' },
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
    autoconsentRules: values['autoconsent-rules'] ?? [],
    vars,
    json: values.json ?? false,
  };
}
