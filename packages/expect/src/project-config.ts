import { LineCounter, isMap as isYamlMap, isPair, isScalar, parseDocument, type Node } from 'yaml';
import { parseOptions, type Path, type ScenarioOptions } from './scenario.ts';

export const configSchemaVersion = 1;

export interface ProjectConfig {
  site?: string;
  out?: string;
  options: ScenarioOptions;
}

export class ProjectConfigError extends Error {
  /** One per problem. Each names the file, the line and the key, never a value. */
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join('\n'));
    this.name = 'ProjectConfigError';
    this.issues = issues;
  }
}

const CONFIG_KEYS = ['configSchemaVersion', 'site', 'out', 'options'];
/** The scenario options a project may share. The rest (`network`, `seed`, timeouts, `cartRequest`, `viewport`) stay in the scenario or on the command line. */
const CONFIG_OPTION_KEYS = ['allowUnknownDestination', 'builtins', 'firstPartyHosts', 'platformHosts', 'serverHosts', 'unloadGapIgnore', 'identifierFields'];
/** Refused at the top level and in `options`: each widens what a run may do or holds a secret. */
const REFUSED_KEYS = ['network', 'serverContainer', 'serverContainerConfig', 'allowTestPayment', 'gtmOverride'];

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validSite(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** `file` is only used in messages. Messages never hold a value from the file. */
export function parseProjectConfig(text: string, file: string): ProjectConfig {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const issues: string[] = [];
  const lineAt = (node: Node | null | undefined): number => (node?.range ? lines.linePos(node.range[0]).line : 1);

  const lineOf = (path: Path): number => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true) as Node | undefined;
      if (node?.range) return lineAt(node);
    }
    return 1;
  };
  const keyLine = (parent: Path, key: string): number => {
    const map = parent.length ? doc.getIn(parent, true) : doc.contents;
    if (isYamlMap(map)) {
      for (const pair of map.items) if (isPair(pair) && isScalar(pair.key) && pair.key.value === key) return lineAt(pair.key as Node);
    }
    return lineOf(parent);
  };
  const report = (line: number, where: string, message: string) => {
    issues.push(`${file}: line ${line}${where ? `, ${where}` : ''}: ${message}`);
  };
  const fail = (path: Path, message: string) => report(lineOf(path), path.join('.'), message);

  for (const e of doc.errors) issues.push(`${file}: line ${e.linePos?.[0].line ?? 1}: not valid YAML (${e.code})`);
  if (issues.length) throw new ProjectConfigError(issues);

  const raw: unknown = doc.toJS();
  if (!isMap(raw)) throw new ProjectConfigError([`${file}: line 1: the project config must be a YAML mapping`]);

  const checkKeys = (map: Record<string, unknown>, parent: Path, allowed: readonly string[]) => {
    for (const key of Object.keys(map)) {
      const where = [...parent, key].join('.');
      if (REFUSED_KEYS.includes(key)) report(keyLine(parent, key), where, 'not allowed in the project config. Pass it on the command line.');
      else if (!allowed.includes(key)) report(keyLine(parent, key), where, `unknown key, expected one of ${allowed.join(', ')}`);
    }
  };
  checkKeys(raw, [], CONFIG_KEYS);

  if (raw.configSchemaVersion === undefined) report(1, 'configSchemaVersion', `required, ${configSchemaVersion}`);
  else if (raw.configSchemaVersion !== configSchemaVersion) fail(['configSchemaVersion'], `must be ${configSchemaVersion}`);

  const config: ProjectConfig = { options: {} };
  if (raw.site !== undefined) {
    if (validSite(raw.site)) config.site = raw.site as string;
    else fail(['site'], 'must be an http or https URL with no user name or password');
  }
  if (raw.out !== undefined) {
    if (typeof raw.out === 'string' && raw.out !== '') config.out = raw.out;
    else fail(['out'], 'must be a folder path');
  }
  if (raw.options !== undefined) {
    if (isMap(raw.options)) {
      checkKeys(raw.options, ['options'], CONFIG_OPTION_KEYS);
      const known = Object.fromEntries(Object.entries(raw.options).filter(([k]) => CONFIG_OPTION_KEYS.includes(k)));
      config.options = parseOptions(known, ['options'], fail, { keys: CONFIG_OPTION_KEYS, echo: false });
    } else fail(['options'], 'must be a mapping');
  }

  if (issues.length) throw new ProjectConfigError(issues);
  return config;
}

/** A scenario's own option wins; a list replaces the config's list. `builtins` merges per check. */
export function mergeOptions(config: ScenarioOptions, scenario: ScenarioOptions): ScenarioOptions {
  const merged: ScenarioOptions = { ...config, ...scenario };
  if (config.builtins || scenario.builtins) merged.builtins = { ...config.builtins, ...scenario.builtins };
  return merged;
}
