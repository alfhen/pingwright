import { parseArgs } from 'node:util';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export type Network = 'stub' | 'server' | 'live';

export interface RunArgs {
  command: 'run';
  scenario: string;
  site: string;
  network: Network | undefined;
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
  allFlags: boolean;
  json: boolean;
}

export interface ReportArgs {
  command: 'report';
  input: string;
  html: string;
}

export interface VariantArg {
  name: string;
  /** GTM override file. Absent for `published`. */
  file?: string;
}

export interface SuiteArgs {
  command: 'suite';
  dir: string;
  site: string;
  variants: VariantArg[];
  network: Network | undefined;
  out: string;
  seed: number | undefined;
  withHandoff: boolean;
  autoconsentRules: string[];
  trackerList: string | undefined;
  vars: Record<string, string>;
  json: boolean;
}

export const PUBLISHED_VARIANT = 'published';
const VARIANT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export type Command = RunArgs | DiffArgs | ReportArgs | SuiteArgs | { command: 'install-browser' } | { command: 'version' } | { command: 'help'; topic?: 'run' };

export const USAGE = `Usage:
  pingwright run <scenario.yml> --site <url> [options]
  pingwright diff <a.jsonl> <b.jsonl> [--by-page] [--all-flags] [--json]
  pingwright report <run.jsonl> --html <out.html>
  pingwright suite <dir> --site <url> [--variant published] [--variant name=override.json] [options]
  pingwright install-browser
  pingwright --version

Run "pingwright run --help" for the options of run.

Options for suite:
  --site <url>               The site to test (required)
  --variant <name[=file]>    A GTM build to test (repeatable). "published" is the live container; name=file serves an override file. Default: published
  --with-handoff             Also run scenarios with handoff steps, last, headed
  --network, --out, --seed, --var, --tracker-list, --autoconsent-rules, --json work as in run

Options for run:
  --site <url>               The site to test (required)
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
`;

export const RUN_USAGE = `Usage: pingwright run <scenario.yml> --site <url> [options]

Plays the scenario in Chromium, records every request, checks the expectations
and writes one JSONL record.

Options:
  --site <url>               The site to test (required)
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: runs)
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable)
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries)
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
  -h, --help                 Show this help

Exit codes: 0 pass, 1 failed expectations, 2 usage or run error.

Scenario format: https://github.com/alfhen/pingwright/blob/main/docs/design.md#11-expectations
`;

export const NET_LOG_NEEDS_LIVE =
  '--net-log needs --network live. In stub mode it would let the requests a frame sends while it unloads leave the machine.';

function parseVariants(entries: string[]): VariantArg[] {
  const variants: VariantArg[] = [];
  for (const entry of entries.length ? entries : [PUBLISHED_VARIANT]) {
    const eq = entry.indexOf('=');
    const name = eq < 0 ? entry : entry.slice(0, eq);
    const file = eq < 0 ? undefined : entry.slice(eq + 1);
    if (!VARIANT_NAME.test(name)) throw new UsageError(`--variant name must match ${VARIANT_NAME.source}, got "${name}"`);
    if (name === PUBLISHED_VARIANT && file !== undefined) throw new UsageError(`--variant "${PUBLISHED_VARIANT}" is reserved for no override and takes no file`);
    if (name !== PUBLISHED_VARIANT && !file) throw new UsageError(`--variant ${name} needs an override file: ${name}=<file>`);
    if (variants.some((v) => v.name === name)) throw new UsageError(`--variant "${name}" is given twice`);
    variants.push(file === undefined ? { name } : { name, file });
  }
  return variants;
}

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
        variant: { type: 'string', multiple: true },
        'with-handoff': { type: 'boolean' },
        var: { type: 'string', multiple: true },
        json: { type: 'boolean' },
        html: { type: 'string' },
        'by-page': { type: 'boolean' },
        'all-flags': { type: 'boolean' },
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
    return { command: 'diff', a: rest[0]!, b: rest[1]!, byPage: values['by-page'] ?? false, allFlags: values['all-flags'] ?? false, json: values.json ?? false };
  }
  if (command === 'report') {
    if (rest.length !== 1) throw new UsageError('report takes one JSONL file');
    if (!values.html) throw new UsageError('report needs --html <file>');
    return { command: 'report', input: rest[0]!, html: values.html };
  }
  if (command !== 'run' && command !== 'suite') throw new UsageError(`Unknown command "${command}"`);

  if (rest.length !== 1) throw new UsageError(command === 'run' ? 'run takes one scenario file' : 'suite takes one scenario directory');
  if (!values.site) throw new UsageError('--site is required');
  try {
    const url = new URL(values.site);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
  } catch {
    throw new UsageError(`--site must be an http or https URL, got "${values.site}"`);
  }
  const network = values.network;
  if (network !== undefined && network !== 'stub' && network !== 'server' && network !== 'live') {
    throw new UsageError(`--network must be stub, server or live, got "${network}"`);
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
  if (command === 'suite') {
    for (const flag of ['gtm-override', 'headed', 'net-log'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} is not an option of suite`);
    }
    return {
      command: 'suite',
      dir: rest[0]!,
      site: values.site,
      variants: parseVariants(values.variant ?? []),
      network,
      out: values.out ?? 'runs',
      seed,
      withHandoff: values['with-handoff'] ?? false,
      autoconsentRules: values['autoconsent-rules'] ?? [],
      trackerList: values['tracker-list'],
      vars,
      json: values.json ?? false,
    };
  }
  for (const flag of ['variant', 'with-handoff'] as const) {
    if (values[flag] !== undefined) throw new UsageError(`--${flag} is not an option of run`);
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
