import { parseArgs } from 'node:util';
import { LABEL_PATTERN } from './out-dir.ts';
import { parseViewportText, VIEWPORT_HINT, type Viewport } from '@tagreeve/expect';

export class UsageError extends Error {
  command: string | undefined;

  constructor(message: string, command?: string) {
    super(message);
    this.name = 'UsageError';
    this.command = command;
  }
}

const COMMANDS = ['run', 'suite', 'diff', 'baseline', 'report', 'init', 'install-browser', 'server-container'] as const;

export function usageHint(command: string | undefined): string {
  return `Run tagreeve ${command ? `${command} ` : ''}--help for the options.`;
}

export type Network = 'stub' | 'server' | 'live';

export interface RunArgs {
  command: 'run';
  scenario: string;
  /** Absent: `site` from the project config. */
  site?: string;
  config?: string;
  network: Network | undefined;
  out: string | undefined;
  label?: string;
  seed: number | undefined;
  headed: boolean;
  viewport?: Viewport;
  allowTestPayment?: string;
  netLog: boolean;
  autoconsentRules: string[];
  gtmOverride: string | undefined;
  baseline: string | undefined;
  trackerList: string | undefined;
  serverContainer?: boolean;
  serverContainerConfig?: string;
  vars: Record<string, string>;
  json: boolean;
}

export interface BaselineArgs {
  command: 'baseline';
  input: string;
  output: string;
  byPage: boolean;
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
  /** Absent: `tagreeve/scenarios`, when it exists. */
  dir?: string;
  /** At most one of `site` and `stores` is set. With neither, `tagreeve/stores.json` is the default. */
  site?: string;
  stores?: string;
  config?: string;
  variants: VariantArg[];
  network: Network | undefined;
  out: string | undefined;
  label?: string;
  seed: number | undefined;
  withHandoff: boolean;
  withTestPayment: boolean;
  allowTestPayment?: string;
  viewport?: Viewport;
  autoconsentRules: string[];
  trackerList: string | undefined;
  serverContainer?: boolean;
  serverContainerConfig?: string;
  vars: Record<string, string>;
  json: boolean;
}

export const PUBLISHED_VARIANT = 'published';
const VARIANT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export interface ServerContainerArgs {
  command: 'server-container';
  action: 'build';
}

export type Command = RunArgs | { command: 'init' } | DiffArgs | BaselineArgs | ReportArgs | SuiteArgs | ServerContainerArgs | { command: 'install-browser' } | { command: 'version' } | { command: 'help'; topic?: HelpTopic };

export type HelpTopic = (typeof COMMANDS)[number];

export const USAGE = `Usage:
  tagreeve run <scenario.yml> [--site <url>] [options]
  tagreeve diff <a.jsonl> <b.jsonl> [--by-page] [--all-flags] [--json]
  tagreeve baseline save <run.jsonl> <baseline.json> [--by-page]
  tagreeve report <run.jsonl | suite-dir> --html <out.html>
  tagreeve suite [<dir>] [--site <url> | --stores <stores.json>] [--variant published] [--variant name=override.json] [options]
  tagreeve init
  tagreeve server-container build
  tagreeve install-browser
  tagreeve --version

Run "tagreeve run --help" for the options of run.

server-container build: builds the image for the server container feature on arm64 (Apple silicon) from Google's image. It needs Docker, pulls large images and never pushes. On amd64 it prints the image to use.

Options for suite:
  --site <url>               The site to test. Without --site and --stores, site in tagreeve/config.yml is used, or else tagreeve/stores.json
  --stores <file>            A stores.json file: run every scenario against each store (instead of --site). Default: tagreeve/stores.json
  --variant <name[=file]>    A GTM build to test (repeatable). "published" is the live container; name=file serves an override file. Default: published
  --with-handoff             Also run scenarios with handoff steps, last, headed
  --with-test-payment        Also run scenarios with a payment step. Needs --allow-test-payment
  --allow-test-payment <host> The host that may run test payments. It must equal the --site host and be in the test-payment-hosts.json allowlist
  --config <file>            The project config, instead of tagreeve/config.yml
  --network, --out, --label, --seed, --viewport, --var, --tracker-list, --autoconsent-rules, --server-container, --server-container-config, --json work as in run

Options for run:
  --site <url>               The site to test. Without it, site in tagreeve/config.yml is used
  --config <file>            The project config, instead of tagreeve/config.yml
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: tagreeve/runs/<date>)
  --label <name>             Name this run: 1 to 40 lowercase letters, digits or hyphens. Stored on the record and added to the default folder name
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --viewport <W>x<H>         Browser viewport in CSS pixels, such as 390x844. Overrides options.viewport. The user agent stays desktop
  --allow-test-payment <host> Let a payment step type a provider's documented test card. The host must equal the --site host and be in the test-payment-hosts.json allowlist
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable). Default: tagreeve/autoconsent/*.json
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries). Default: tagreeve/trackers.json
  --server-container         Run your own server container in Docker and record the calls it makes to vendors. Needs --network server and options.serverHosts. See docs/cli.md
  --server-container-config <file> The container config (mode 0600). Or set TAGREEVE_SERVER_CONTAINER_CONFIG
  --baseline <file>          Compare the hits with a baseline file and fail on drift
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
`;

export const RUN_USAGE = `Usage: tagreeve run <scenario.yml> [--site <url>] [options]

Plays the scenario in Chromium, records every request, checks the expectations
and writes one JSONL record.

Options:
  --site <url>               The site to test. Without it, site in tagreeve/config.yml is used
  --config <file>            The project config, instead of tagreeve/config.yml
  --network stub|server|live stub (default) answers tracking requests locally; server also passes through the hosts in options.serverHosts; live sends them
  --out <dir>                Directory for the JSONL record (default: tagreeve/runs/<date>)
  --label <name>             Name this run: 1 to 40 lowercase letters, digits or hyphens. Stored on the record and added to the default folder name
  --seed <n>                 Seed for the fake identity
  --headed                   Show the browser window
  --viewport <W>x<H>         Browser viewport in CSS pixels, such as 390x844. Overrides options.viewport. The user agent stays desktop
  --allow-test-payment <host> Let a payment step type a provider's documented test card. The host must equal the --site host and be in the test-payment-hosts.json allowlist
  --net-log                  Capture collection requests no browser hook reports (unload sends, early sandboxed srcdoc sends) from Chromium's net log (needs --network live)
  --autoconsent-rules <file> Extra autoconsent rules (repeatable). Default: tagreeve/autoconsent/*.json
  --gtm-override <file>      Serve a GTM workspace build (JSON with container, gtmAuth, gtmPreview, optional loader.replace or loader.match)
  --tracker-list <file>      Extra tracker hosts to stub and decode (JSON array of entries). Default: tagreeve/trackers.json
  --server-container         Run your own server container in Docker and record the calls it makes to vendors. Needs --network server and options.serverHosts. See docs/cli.md
  --server-container-config <file> The container config (mode 0600). Or set TAGREEVE_SERVER_CONTAINER_CONFIG
  --baseline <file>          Compare the hits with a baseline file made by "tagreeve baseline save" and fail on drift
  --var <k=v>                Scenario variable (repeatable)
  --json                     Print a JSON summary on stdout
  -h, --help                 Show this help

Exit codes: 0 pass, 1 failed expectations, 2 usage or run error.

Scenario format: https://github.com/alfhen/tagreeve/blob/main/docs/design.md#11-expectations
`;

const SUITE_USAGE = `Usage: tagreeve suite [<dir>] [--site <url> | --stores <stores.json>] [options]

Runs every scenario in <dir> (default: tagreeve/scenarios) and writes one record per run plus a suite.json.

Options:
${USAGE.slice(USAGE.indexOf('  --site <url>               The site to test. Without'), USAGE.indexOf('\nOptions for run:')).trimEnd()}
  -h, --help                 Show this help
`;

const DIFF_USAGE = `Usage: tagreeve diff <a.jsonl> <b.jsonl> [options]

Compares the hits of two run records. It exits 0 whether or not they differ.

Options:
  --by-page                  Add the page path to each key
  --all-flags                Also show flag count changes for hosts allowed by allowUnknownDestination and for platform hosts (hidden by default)
  --json                     Print the full diff result as JSON
  -h, --help                 Show this help
`;

const BASELINE_USAGE = `Usage: tagreeve baseline save <run.jsonl> <baseline.json> [options]

Saves the hit tuples of a run as a baseline file. Pass the file to "tagreeve run --baseline".

Options:
  --by-page                  Add the page path to each key
  -h, --help                 Show this help
`;

const REPORT_USAGE = `Usage: tagreeve report <run.jsonl | suite-dir> --html <out.html>

Writes an HTML report for a run record or a suite directory.

Options:
  --html <file>              The report file to write (required)
  -h, --help                 Show this help
`;

const INIT_USAGE = `Usage: tagreeve init

Makes tagreeve/scenarios/ and tagreeve/baselines/ in the current directory, and adds /tagreeve/runs/ to ./.gitignore unless the work tree already ignores it. It writes no scenario, never overwrites a file and says what it did or skipped. It takes no options.

Options:
  -h, --help                 Show this help
`;

const INSTALL_BROWSER_USAGE = `Usage: tagreeve install-browser

Installs the Chromium that Tagreeve drives. It takes no options.

Options:
  -h, --help                 Show this help
`;

const SERVER_CONTAINER_USAGE = `Usage: tagreeve server-container build

Builds the image for the server container feature on arm64 (Apple silicon) from Google's image. It needs Docker, pulls large images and never pushes. On amd64 it prints the image to use.

Options:
  -h, --help                 Show this help
`;

const HELP_TEXT: Record<HelpTopic, string> = {
  run: RUN_USAGE,
  suite: SUITE_USAGE,
  diff: DIFF_USAGE,
  baseline: BASELINE_USAGE,
  report: REPORT_USAGE,
  init: INIT_USAGE,
  'install-browser': INSTALL_BROWSER_USAGE,
  'server-container': SERVER_CONTAINER_USAGE,
};

export function helpText(topic: HelpTopic | undefined): string {
  return topic ? HELP_TEXT[topic] : USAGE;
}

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

const OPTIONS = {
  site: { type: 'string' },
  stores: { type: 'string' },
  config: { type: 'string' },
  network: { type: 'string' },
  out: { type: 'string' },
  label: { type: 'string' },
  seed: { type: 'string' },
  headed: { type: 'boolean' },
  viewport: { type: 'string' },
  'net-log': { type: 'boolean' },
  'autoconsent-rules': { type: 'string', multiple: true },
  'gtm-override': { type: 'string' },
  'tracker-list': { type: 'string' },
  'server-container': { type: 'boolean' },
  'server-container-config': { type: 'string' },
  baseline: { type: 'string' },
  variant: { type: 'string', multiple: true },
  'with-handoff': { type: 'boolean' },
  'with-test-payment': { type: 'boolean' },
  'allow-test-payment': { type: 'string' },
  var: { type: 'string', multiple: true },
  json: { type: 'boolean' },
  html: { type: 'string' },
  'by-page': { type: 'boolean' },
  'all-flags': { type: 'boolean' },
  version: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

function commandOf(argv: string[]): HelpTopic | undefined {
  const { tokens } = parseArgs({ args: argv, allowPositionals: true, strict: false, options: OPTIONS, tokens: true });
  // An unknown option may take the next word as its value, so that word is a command only when no other word is.
  const isCommand = (word: string): boolean => (COMMANDS as readonly string[]).includes(word);
  let skip = false;
  let skipped: string | undefined;
  for (const token of tokens) {
    if (token.kind === 'option') {
      skip = !(token.name in OPTIONS) && token.value === undefined;
    } else if (token.kind === 'positional') {
      if (!skip) return isCommand(token.value) ? (token.value as HelpTopic) : skipped as HelpTopic | undefined;
      if (skipped === undefined && isCommand(token.value)) skipped = token.value;
      skip = false;
    }
  }
  return skipped as HelpTopic | undefined;
}

export function parseCli(argv: string[]): Command {
  try {
    return parseCommand(argv);
  } catch (error) {
    if (error instanceof UsageError && error.command === undefined) {
      const command = commandOf(argv);
      if (command !== undefined) error.command = command;
    }
    throw error;
  }
}

function parseCommand(argv: string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: OPTIONS,
    });
  } catch (error) {
    const unknown = error instanceof Error && /^Unknown option '(-[^']*)'/.exec(error.message);
    if (unknown) throw new UsageError(`Unknown option ${unknown[1]}.`);
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.version) return { command: 'version' };
  const [command, ...rest] = positionals;
  if (values.help && command !== undefined && (COMMANDS as readonly string[]).includes(command)) {
    return { command: 'help', topic: command as HelpTopic };
  }
  if (values.help || command === undefined) return { command: 'help' };
  if (command === 'init') {
    if (rest.length) throw new UsageError('init takes no arguments');
    return { command: 'init' };
  }
  if (command === 'install-browser') {
    if (rest.length) throw new UsageError('install-browser takes no arguments');
    return { command: 'install-browser' };
  }
  if (command === 'server-container') {
    if (rest[0] !== 'build') throw new UsageError('server-container needs a subcommand: build');
    if (rest.length !== 1) throw new UsageError('server-container build takes no arguments');
    return { command: 'server-container', action: 'build' };
  }
  if (command === 'diff') {
    if (rest.length !== 2) throw new UsageError('diff takes two JSONL files');
    return { command: 'diff', a: rest[0]!, b: rest[1]!, byPage: values['by-page'] ?? false, allFlags: values['all-flags'] ?? false, json: values.json ?? false };
  }
  if (command === 'baseline') {
    if (rest[0] !== 'save') throw new UsageError('baseline needs a subcommand: save');
    if (rest.length !== 3) throw new UsageError('baseline save takes a JSONL file and a baseline file');
    return { command: 'baseline', input: rest[1]!, output: rest[2]!, byPage: values['by-page'] ?? false };
  }
  if (command === 'report') {
    if (rest.length !== 1) throw new UsageError('report takes one JSONL file or one suite directory');
    if (!values.html) throw new UsageError('report needs --html <file>');
    return { command: 'report', input: rest[0]!, html: values.html };
  }
  if (command !== 'run' && command !== 'suite') throw new UsageError(`Unknown command "${command}"`);

  if (command === 'run' ? rest.length !== 1 : rest.length > 1) throw new UsageError(command === 'run' ? 'run takes one scenario file' : 'suite takes at most one scenario directory');
  if (command === 'suite') {
    if (values.site !== undefined && values.stores !== undefined) throw new UsageError('--site and --stores cannot be used together');
  }
  if (values.site !== undefined) {
    try {
      const url = new URL(values.site);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    } catch {
      throw new UsageError(`--site must be an http or https URL, got "${values.site}"`);
    }
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
  let viewport: Viewport | undefined;
  if (values.viewport !== undefined) {
    viewport = parseViewportText(values.viewport);
    if (!viewport) throw new UsageError(`--viewport must be ${VIEWPORT_HINT}, got "${values.viewport}"`);
  }
  if (values.label !== undefined && !LABEL_PATTERN.test(values.label)) {
    throw new UsageError(`--label must be 1 to 40 lowercase letters, digits or hyphens, got "${values.label}"`);
  }
  if (values['server-container-config'] !== undefined && !values['server-container']) {
    throw new UsageError('--server-container-config needs --server-container');
  }
  const vars: Record<string, string> = {};
  for (const entry of values.var ?? []) {
    const eq = entry.indexOf('=');
    if (eq < 1) throw new UsageError(`--var must look like name=value, got "${entry}"`);
    vars[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  if (command === 'suite') {
    for (const flag of ['baseline', 'gtm-override', 'headed', 'net-log'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} is not an option of suite`);
    }
    return {
      command: 'suite',
      ...(rest[0] !== undefined && { dir: rest[0] }),
      ...(values.site !== undefined && { site: values.site }),
      ...(values.stores !== undefined && { stores: values.stores }),
      ...(values.config !== undefined && { config: values.config }),
      variants: parseVariants(values.variant ?? []),
      network,
      out: values.out,
      ...(values.label !== undefined && { label: values.label }),
      seed,
      withHandoff: values['with-handoff'] ?? false,
      withTestPayment: values['with-test-payment'] ?? false,
      ...(values['allow-test-payment'] !== undefined && { allowTestPayment: values['allow-test-payment'] }),
      ...(viewport && { viewport }),
      autoconsentRules: values['autoconsent-rules'] ?? [],
      trackerList: values['tracker-list'],
      ...(values['server-container'] && { serverContainer: true }),
      ...(values['server-container-config'] !== undefined && { serverContainerConfig: values['server-container-config'] }),
      vars,
      json: values.json ?? false,
    };
  }
  for (const flag of ['variant', 'with-handoff', 'with-test-payment', 'stores'] as const) {
    if (values[flag] !== undefined) throw new UsageError(`--${flag} is not an option of run`);
  }
  return {
    command: 'run',
    scenario: rest[0]!,
    ...(values.site !== undefined && { site: values.site }),
    ...(values.config !== undefined && { config: values.config }),
    network,
    out: values.out,
    ...(values.label !== undefined && { label: values.label }),
    seed,
    headed: values.headed ?? false,
    ...(viewport && { viewport }),
    ...(values['allow-test-payment'] !== undefined && { allowTestPayment: values['allow-test-payment'] }),
    netLog: values['net-log'] ?? false,
    autoconsentRules: values['autoconsent-rules'] ?? [],
    gtmOverride: values['gtm-override'],
    trackerList: values['tracker-list'],
    baseline: values.baseline,
    ...(values['server-container'] && { serverContainer: true }),
    ...(values['server-container-config'] !== undefined && { serverContainerConfig: values['server-container-config'] }),
    vars,
    json: values.json ?? false,
  };
}
