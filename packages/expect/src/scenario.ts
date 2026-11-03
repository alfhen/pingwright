import { FICTIONAL_PHONE_HINT } from '@tagreeve/core';
import type { ConsentValue, NetworkMode, RequestOutcome, Severity } from '@tagreeve/core';
import { trackerVendorKeys, vendorKeys } from '@tagreeve/decoders';
import { LineCounter, parseDocument } from 'yaml';
import { isHostPattern, isServerHostPattern, isSpecificServerHost } from './hosts.ts';
import { PAYMENT_PROVIDERS, canonicalCard, findPaymentProvider } from './payment-providers.ts';

export type ConsentField = 'analytics' | 'ads' | 'adUserData' | 'adPersonalization';

export const consentFields: readonly ConsentField[] = ['analytics', 'ads', 'adUserData', 'adPersonalization'];

export type CountOp = '>=' | '>' | '<=' | '<' | '=';

export interface Count {
  op: CountOp;
  n: number;
}

export interface Filter {
  vendor?: string[];
  event?: string[];
  consent: Partial<Record<ConsentField, ConsentValue>>;
  /** `present`, `absent` or an exact value. */
  ids: Record<string, string>;
  page?: { equals: string } | { matches: string };
  transport?: string[];
  host?: string[];
  outcome?: RequestOutcome[];
  params: Record<string, string>;
}

export interface Rule {
  kind: 'must' | 'mustNot';
  /** The entry as written, for messages. */
  description: string;
  line: number;
  filter: Filter;
  count?: Count;
  before?: 'consent';
  /** The text inside `epoch(...)`. */
  inEpoch?: string;
  after?: string;
  hashesMatch?: boolean;
  body?: { has?: string[]; only?: string[]; ignore?: string[] };
  /** Cookie names or `*` globs. A cookie rule selects cookies, not hits. */
  cookie?: string[];
}

/** A selector string, a role and accessible name, or a list of selectors tried in order. */
export type Locator = string | { role: string; name?: string; exact?: boolean } | { any: string[] };

/** A URL pattern: a path glob matched against the path and query, or a regular expression matched against the whole URL. */
export type UrlMatcher = { glob: string } | { matches: string };

/** What a `handoff` `until` or a `wait` waits for. */
export type Condition = { url: UrlMatcher } | { locator: Locator };

export type StepBody =
  | { kind: 'visit'; value: string }
  | { kind: 'click'; value: Locator }
  | { kind: 'fill'; value: Record<string, string>; optional?: string[] }
  | { kind: 'select'; value: Record<string, string> }
  | { kind: 'consent'; value: 'accept' | 'reject' | 'none' | 'withdraw' }
  | { kind: 'wait'; value: number | { selector: Locator } | { url: UrlMatcher } }
  | { kind: 'addToCart'; value: string }
  | { kind: 'evaluate'; value: string }
  | { kind: 'checkpoint'; value: string }
  | { kind: 'handoff'; value: string; until?: Condition; settle?: number; timeout?: number }
  | { kind: 'payment'; value: { provider: string; card: string } };

/** `label` is the written label, or the default: the checkpoint's own name, else the kind and the step's index. */
export type Step = StepBody & { label: string; line: number };

export interface Viewport {
  width: number;
  height: number;
}

export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 4000;

function isViewportSide(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= VIEWPORT_MIN && n <= VIEWPORT_MAX;
}

/** Reads `<W>x<H>`. Returns undefined for anything else, including `mobile`. */
export function parseViewportText(text: string): Viewport | undefined {
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(text);
  if (!match) return undefined;
  const viewport = { width: Number(match[1]), height: Number(match[2]) };
  return isViewportSide(viewport.width) && isViewportSide(viewport.height) ? viewport : undefined;
}

export const VIEWPORT_HINT = `a size such as 390x844, with each side from ${VIEWPORT_MIN} to ${VIEWPORT_MAX}`;

export interface ScenarioOptions {
  network?: NetworkMode;
  seed?: number;
  consentTimeout?: number;
  graceWindow?: number;
  /** Milliseconds an `optional` fill entry waits for its field. */
  optionalTimeout?: number;
  /** `true` allows every unknown destination. A list allows only those hosts or `*.domain` wildcards. */
  allowUnknownDestination?: boolean | string[];
  firstPartyHosts?: string[];
  /** `false` makes requests to known platform hosts `unknownDestination` again. Default: true. */
  platformHosts?: boolean;
  /** Regular expression matched against request URLs: a matching request in an `addToCart` step counts as a cart change. */
  cartRequest?: string;
  /** dataLayer event names or `*` globs that `unloadGap` never reports. */
  unloadGapIgnore?: string[];
  /** Extra field names or `*` globs that `deniedIdentifiers` and `earlyIdentifiers` treat as analytics identifiers, matched against `Hit.fields`. */
  identifierFields?: string[];
  /** Hosts or `*.domain` wildcards that `server` mode passes through to the network. Every other collection request stays stubbed. */
  serverHosts?: string[];
  /** Browser viewport in CSS pixels. `--viewport` overrides it. */
  viewport?: Viewport;
  /** Severity per built-in check. A check that is not listed is `fail`, except `earlyIdentifiers`, which is `warn`. */
  builtins?: Partial<Record<BuiltinName, Severity>>;
}

export const BUILTIN_NAMES = ['unknownDestination', 'sandboxPageUrl', 'possibleRealData', 'deniedIdentifiers', 'earlyIdentifiers'] as const;
export type BuiltinName = (typeof BUILTIN_NAMES)[number];
export const SEVERITIES = ['fail', 'warn'] as const;

export const IDENTITY_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'zip', 'country'] as const;
export type IdentityField = (typeof IDENTITY_FIELDS)[number];

export interface Scenario {
  start: string;
  vars: Record<string, string>;
  /** Fields of the run identity that the scenario sets instead of generating. */
  identity: Partial<Record<IdentityField, string>>;
  steps: Step[];
  expect: { must: Rule[]; mustNot: Rule[] };
  options: ScenarioOptions;
  /** Problems that do not stop the scenario from running. */
  warnings: string[];
}

export class ScenarioError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join('\n'));
    this.name = 'ScenarioError';
    this.issues = issues;
  }
}

const VENDOR_KEYS = new Set(['vendor', 'event', 'page', 'transport', 'host', 'outcome', 'count', 'before', 'in', 'after']);
const GROUP_KEYS = ['consent', 'ids', 'params', 'identity', 'body'] as const;
const COOKIE_RULE_KEYS = ['cookie', 'before', 'in', 'after'];
const BODY_KEYS = ['has', 'only', 'ignore'] as const;
const MAX_FIELD_NAME = 64;
const CONSENT_VALUES = ['granted', 'denied', 'unknown'];
const OUTCOMES = ['passed', 'stubbed', 'failed'];
const NETWORKS = ['stub', 'server', 'live'];
const CONSENT_ANSWERS = ['accept', 'reject', 'none', 'withdraw'];
const STEP_KINDS = ['visit', 'click', 'fill', 'select', 'consent', 'wait', 'addToCart', 'evaluate', 'checkpoint', 'handoff', 'payment'];
const TOP_KEYS = ['start', 'vars', 'identity', 'steps', 'expect', 'options'];
const OPTION_KEYS = ['network', 'seed', 'consentTimeout', 'graceWindow', 'optionalTimeout', 'allowUnknownDestination', 'firstPartyHosts', 'platformHosts', 'cartRequest', 'unloadGapIgnore', 'builtins', 'identifierFields', 'serverHosts', 'viewport'];

const HOST_HINT = ', each a host such as cdn.example.com or a wildcard such as *.example.com';

function isRegExp(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

function isHostList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(isHostPattern);
}

type Path = (string | number)[];

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Parses "4s", "500ms", "2m" or a plain number of milliseconds. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)?$/.exec(value.trim());
  if (!m) return undefined;
  const unit = m[2] ?? 'ms';
  return Number(m[1]) * (unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1);
}

export function parseCount(value: unknown): Count | undefined {
  const text = String(value).trim();
  const m = /^(>=|<=|>|<|=)?\s*(\d+)$/.exec(text);
  if (!m || (typeof value !== 'string' && typeof value !== 'number')) return undefined;
  return { op: (m[1] as CountOp | undefined) ?? '=', n: Number(m[2]) };
}

export function countHolds(count: Count, actual: number): boolean {
  switch (count.op) {
    case '>=':
      return actual >= count.n;
    case '>':
      return actual > count.n;
    case '<=':
      return actual <= count.n;
    case '<':
      return actual < count.n;
    case '=':
      return actual === count.n;
  }
}

export function describeCount(count: Count): string {
  return count.op === '=' ? String(count.n) : `${count.op}${count.n}`;
}

/** `extraVendorKeys` are vendor keys from a user tracker list, valid in `vendor:` besides the built-in ones. */
export function parseScenario(text: string, extraVendorKeys: readonly string[] = []): Scenario {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const issues: string[] = [];

  const lineOf = (path: Path): number => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true) as { range?: number[] | null } | undefined;
      if (node?.range) return lines.linePos(node.range[0] ?? 0).line;
    }
    return 1;
  };
  const fail = (path: Path, message: string) => {
    const where = path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '');
    issues.push(`line ${lineOf(path)}: ${where ? `${where}: ` : ''}${message}`);
  };

  for (const e of doc.errors) issues.push(`line ${e.linePos?.[0].line ?? 1}: ${e.message.split('\n')[0]}`);
  if (issues.length) throw new ScenarioError(issues);

  const raw: unknown = doc.toJS();
  if (!isMap(raw)) throw new ScenarioError(['line 1: a scenario must be a YAML mapping']);

  for (const key of Object.keys(raw)) if (!TOP_KEYS.includes(key)) fail([key], `unknown key, expected one of ${TOP_KEYS.join(', ')}`);

  let start = '';
  if (typeof raw.start !== 'string' || !raw.start) fail(['start'], 'required, a path such as /products/{product}');
  else start = raw.start;

  const vars: Record<string, string> = {};
  if (raw.vars !== undefined) {
    if (!isMap(raw.vars)) fail(['vars'], 'must be a mapping of names to values');
    else
      for (const [k, v] of Object.entries(raw.vars)) {
        if (typeof v === 'string' || typeof v === 'number') vars[k] = String(v);
        else fail(['vars', k], 'must be a string or number');
      }
  }

  const warnings: string[] = [];
  const identity: Partial<Record<IdentityField, string>> = {};
  if (raw.identity !== undefined) {
    if (!isMap(raw.identity)) fail(['identity'], `must be a mapping of identity fields to values, from ${IDENTITY_FIELDS.join(', ')}`);
    else
      for (const [k, v] of Object.entries(raw.identity)) {
        if (!(IDENTITY_FIELDS as readonly string[]).includes(k)) fail(['identity', k], `unknown identity field, expected one of ${IDENTITY_FIELDS.join(', ')}`);
        else if (typeof v !== 'string' || !v.trim()) fail(['identity', k], 'must be a non-empty string');
        else {
          identity[k as IdentityField] = v;
        }
      }
    for (const [k, v] of Object.entries(identity)) {
      const problem = realDataWarning(v, identity.country);
      if (problem) warnings.push(`line ${lineOf(['identity', k])}: identity.${k}: ${problem}; do not write personal data in a scenario`);
    }
  }

  const checkVars = (value: string, path: Path) => {
    for (const m of value.matchAll(/\{(\w+)\}/g)) {
      if (!Object.hasOwn(vars, m[1]!)) fail(path, `uses {${m[1]}} but vars has no "${m[1]}"`);
    }
  };
  if (start) checkVars(start, ['start']);

  const steps: Step[] = [];
  const stepLabels = new Set<string>(['start']);
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) fail(['steps'], 'must be a list');
    else raw.steps.forEach((item, i) => parseStep(item, i));
  }

  function parseStep(item: unknown, i: number) {
    const path: Path = ['steps', i];
    const line = lineOf(path);
    const keys = isMap(item) ? Object.keys(item).filter((k) => k !== 'label') : [];
    if (!isMap(item) || keys.length !== 1) {
      fail(path, `a step is a mapping with exactly one key, one of ${STEP_KINDS.join(', ')}, and an optional label`);
      return;
    }
    const kind = keys[0]!;
    const value = item[kind];
    let label = `${kind}-${i + 1}`;
    if (item.label !== undefined) {
      if (typeof item.label === 'string' && /^[\w.-]+$/.test(item.label)) label = item.label;
      else fail([...path, 'label'], 'must be a string of letters, digits, dots, dashes and underscores');
    } else if (kind === 'checkpoint' && typeof value === 'string' && value) label = value;
    const add = (body: StepBody) => {
      if (stepLabels.has(label)) fail([...path, ...(item.label === undefined ? [kind] : ['label'])], `duplicate step label "${label}"`);
      stepLabels.add(label);
      steps.push({ ...body, label, line });
    };
    const str = (): string | undefined => {
      if (typeof value === 'string' && value) return value;
      fail([...path, kind], 'must be a non-empty string');
      return undefined;
    };
    const locator = (v: unknown = value, at: Path = [...path, kind]): Locator | undefined => {
      if (typeof v === 'string' && v) return v;
      if (!isMap(v)) {
        fail(at, 'must be a non-empty selector or a mapping with role and name, or any');
        return undefined;
      }
      const keys = Object.keys(v);
      if (keys.includes('any')) {
        const list = v.any;
        if (keys.length > 1) fail(at, 'any cannot be combined with other keys');
        else if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string' && x !== '')) {
          fail([...at, 'any'], 'must be a non-empty list of selectors');
        } else return { any: list as string[] };
        return undefined;
      }
      const unknown = keys.find((k) => !['role', 'name', 'exact'].includes(k));
      if (unknown !== undefined) fail([...at, unknown], 'unknown key, expected role, name, exact or any');
      else if (typeof v.role !== 'string' || !/^[a-z]+$/.test(v.role)) fail([...at, 'role'], 'must be a role name such as button or radio');
      else if (v.name !== undefined && (typeof v.name !== 'string' || v.name === '')) fail([...at, 'name'], 'must be a non-empty string');
      else if (v.exact !== undefined && typeof v.exact !== 'boolean') fail([...at, 'exact'], 'must be true or false');
      else if (v.exact !== undefined && v.name === undefined) fail([...at, 'exact'], 'needs a name');
      else {
        return {
          role: v.role,
          ...(v.name !== undefined ? { name: v.name as string } : {}),
          ...(v.exact !== undefined ? { exact: v.exact as boolean } : {}),
        };
      }
      return undefined;
    };
    const urlMatcher = (v: unknown, at: Path): UrlMatcher | undefined => {
      if (typeof v === 'string' && v) return { glob: v };
      if (isMap(v) && Object.keys(v).length === 1 && 'matches' in v) {
        if (typeof v.matches !== 'string' || !v.matches) fail([...at, 'matches'], 'must be a non-empty regular expression');
        else
          try {
            new RegExp(v.matches);
            return { matches: v.matches };
          } catch {
            fail([...at, 'matches'], `"${v.matches}" is not a valid regular expression`);
          }
        return undefined;
      }
      fail(at, 'must be a path glob such as "/thank-you*" or a mapping with matches');
      return undefined;
    };
    const condition = (v: unknown, at: Path): Condition | undefined => {
      if (!isMap(v)) {
        fail(at, 'must be a mapping with url, or a locator (role and name, any, or selector)');
        return undefined;
      }
      if ('url' in v) {
        if (Object.keys(v).length > 1) fail(at, 'url cannot be combined with other keys');
        else {
          const url = urlMatcher(v.url, [...at, 'url']);
          if (url) return { url };
        }
        return undefined;
      }
      if ('selector' in v) {
        if (Object.keys(v).length > 1) fail(at, 'selector cannot be combined with other keys');
        else if (typeof v.selector !== 'string' || !v.selector) fail([...at, 'selector'], 'must be a non-empty selector');
        else return { locator: v.selector };
        return undefined;
      }
      const l = locator(v, at);
      return l === undefined ? undefined : { locator: l };
    };
    switch (kind) {
      case 'visit': {
        const v = str();
        if (v !== undefined) {
          checkVars(v, [...path, kind]);
          add({ kind, value: v });
        }
        return;
      }
      case 'click': {
        const v = locator();
        if (v !== undefined) add({ kind, value: v });
        return;
      }
      case 'addToCart':
      case 'evaluate':
      case 'checkpoint': {
        const v = str();
        if (v !== undefined) add({ kind, value: v });
        return;
      }
      case 'handoff': {
        if (!isMap(value)) {
          const v = str();
          if (v !== undefined) add({ kind, value: v });
          return;
        }
        const at = [...path, kind];
        const unknown = Object.keys(value).find((k) => !['text', 'until', 'settle', 'timeout'].includes(k));
        if (unknown !== undefined) {
          fail([...at, unknown], 'unknown key, expected text, until, settle or timeout');
          return;
        }
        const errors = issues.length;
        if (typeof value.text !== 'string' || !value.text) fail([...at, 'text'], 'must be a non-empty string');
        const until = value.until === undefined ? undefined : condition(value.until, [...at, 'until']);
        const duration = (key: 'settle' | 'timeout') => {
          if (value[key] === undefined) return undefined;
          const ms = parseDuration(value[key]);
          if (ms === undefined) fail([...at, key], 'must be a duration such as 4s, 500ms or 10m');
          return ms;
        };
        const settle = duration('settle');
        const timeout = duration('timeout');
        if (value.settle !== undefined && value.until === undefined) fail([...at, 'settle'], 'needs until');
        if (issues.length > errors) return;
        add({
          kind,
          value: value.text as string,
          ...(until ? { until, settle: settle ?? 5000 } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
        });
        return;
      }
      case 'payment': {
        const at = [...path, kind];
        if (!isMap(value)) {
          fail(at, 'must be a mapping with provider and card');
          return;
        }
        const unknown = Object.keys(value).find((k) => !['provider', 'card'].includes(k));
        if (unknown !== undefined) {
          fail([...at, unknown], 'unknown key, expected provider or card');
          return;
        }
        const provider = typeof value.provider === 'string' ? findPaymentProvider(value.provider) : undefined;
        if (!provider) {
          fail([...at, 'provider'], `must be one of ${PAYMENT_PROVIDERS.map((p) => p.id).join(', ')}`);
          return;
        }
        const card = typeof value.card === 'string' || typeof value.card === 'number' ? canonicalCard(provider, String(value.card)) : undefined;
        if (card === undefined) {
          fail([...at, 'card'], `is not a documented test value of ${provider.id}, see ${provider.docs}`);
          return;
        }
        add({ kind, value: { provider: provider.id, card } });
        return;
      }
      case 'select': {
        if (!isMap(value) || Object.keys(value).length === 0) {
          fail([...path, kind], 'must be a mapping of selector to option value or label');
          return;
        }
        const fields: Record<string, string> = {};
        for (const [sel, v] of Object.entries(value)) {
          if (typeof v === 'string' && v) fields[sel] = v;
          else if (typeof v === 'number') fail([...path, kind, sel], `must be a string, so quote it ("${v}") to keep leading zeros`);
          else fail([...path, kind, sel], 'must be a non-empty string');
        }
        add({ kind, value: fields });
        return;
      }
      case 'fill': {
        if (!isMap(value) || Object.keys(value).length === 0) {
          fail([...path, kind], 'must be a mapping of selector to value');
          return;
        }
        const fields: Record<string, string> = {};
        const optional: string[] = [];
        for (const [sel, raw] of Object.entries(value)) {
          let v = raw;
          if (isMap(raw)) {
            const extra = Object.keys(raw).filter((key) => key !== 'value' && key !== 'optional');
            if (extra.length || typeof raw.value !== 'string' || !raw.value || raw.optional !== true) {
              fail([...path, kind, sel], 'must be a string, or { value: <string>, optional: true }');
              continue;
            }
            v = raw.value;
            optional.push(sel);
          }
          if (typeof v === 'string' && v) {
            fields[sel] = v;
            const problem = SECRET_FIELD.test(sel) ? undefined : realDataWarning(v, identity.country);
            if (problem) warnings.push(`line ${lineOf([...path, 'fill', sel])}: steps[${i}].fill.${sel}: ${problem}; fill uses the run identity, so do not write personal data in a scenario`);
          } else fail([...path, kind, sel], 'must be a non-empty string');
        }
        add(optional.length ? { kind, value: fields, optional } : { kind, value: fields });
        return;
      }
      case 'consent': {
        if (typeof value === 'string' && CONSENT_ANSWERS.includes(value)) add({ kind, value: value as never });
        else fail([...path, kind], `must be one of ${CONSENT_ANSWERS.join(', ')}`);
        return;
      }
      case 'wait': {
        const ms = parseDuration(value);
        if (ms !== undefined) add({ kind, value: ms });
        else if (typeof value === 'string' && /^\s*\d/.test(value)) fail([...path, kind], `"${value}" is not a duration such as 4s, 500ms or 2m`);
        else if (typeof value === 'string' && value.trim()) add({ kind, value: { selector: value } });
        else if (isMap(value) && 'url' in value) {
          if (Object.keys(value).length > 1) fail([...path, kind], 'url cannot be combined with other keys');
          else {
            const url = urlMatcher(value.url, [...path, kind, 'url']);
            if (url) add({ kind, value: { url } });
          }
        } else if (isMap(value)) {
          const v = locator();
          if (v !== undefined) add({ kind, value: { selector: v } });
        } else fail([...path, kind], 'must be a duration such as 4s, 500ms or 2m, a selector, or a locator mapping');
        return;
      }
      default:
        fail([...path, kind], `unknown step "${kind}", expected one of ${STEP_KINDS.join(', ')}`);
    }
  }

  const expectOut: Scenario['expect'] = { must: [], mustNot: [] };
  if (raw.expect !== undefined) {
    if (!isMap(raw.expect)) fail(['expect'], 'must be a mapping with must and mustNot lists');
    else {
      for (const key of Object.keys(raw.expect)) if (key !== 'must' && key !== 'mustNot') fail(['expect', key], 'unknown key, expected must or mustNot');
      for (const kind of ['must', 'mustNot'] as const) {
        const list = raw.expect[kind];
        if (list === undefined) continue;
        if (!Array.isArray(list)) fail(['expect', kind], 'must be a list');
        else
          list.forEach((entry, i) => {
            const rule = parseRule(kind, entry, ['expect', kind, i]);
            if (rule) expectOut[kind].push(rule);
          });
      }
    }
  }

  function parseRule(kind: Rule['kind'], entry: unknown, path: Path): Rule | undefined {
    if (!isMap(entry)) {
      fail(path, 'must be a mapping of filters and rule keys');
      return undefined;
    }
    const before = issues.length;
    const flat: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(entry)) {
      if ((GROUP_KEYS as readonly string[]).includes(k) && isMap(v)) {
        for (const [sub, sv] of Object.entries(v)) flat[`${k}.${sub}`] = sv;
      } else flat[k] = v;
    }
    const filter: Filter = { consent: {}, ids: {}, params: {} };
    const rule: Rule = { kind, description: JSON.stringify(entry), line: lineOf(path), filter };
    const list = (key: string, v: unknown, allowed?: string[]): string[] | undefined => {
      const items = Array.isArray(v) ? v : [v];
      if (items.length === 0 || !items.every((x) => typeof x === 'string' && x)) {
        fail([...path, key], 'must be a string or a list of strings');
        return undefined;
      }
      const out = items as string[];
      const bad = allowed ? out.find((x) => !allowed.includes(x)) : undefined;
      if (bad !== undefined) {
        fail([...path, key], `"${bad}" is not valid, expected one of ${allowed!.join(', ')}`);
        return undefined;
      }
      return out;
    };

    for (const [k, v] of Object.entries(flat)) {
      const p = [...path, k];
      if (k.startsWith('consent.')) {
        const field = k.slice(8) as ConsentField;
        if (!consentFields.includes(field)) fail(p, `unknown consent field, expected one of ${consentFields.join(', ')}`);
        else if (typeof v === 'string' && CONSENT_VALUES.includes(v)) filter.consent[field] = v as ConsentValue;
        else fail(p, `must be one of ${CONSENT_VALUES.join(', ')}`);
      } else if (k.startsWith('ids.')) {
        const name = k.slice(4);
        if (/^hashes(?:\.|$)/.test(name) && !/^hashes(?:\.[^.]+(?:\.matchesIdentity)?)?$/.test(name)) {
          fail(p, 'is not valid, expected ids.hashes, ids.hashes.<param> or ids.hashes.<param>.matchesIdentity');
        } else if (v === true) filter.ids[k.slice(4)] = 'present';
        else if (v === false) filter.ids[k.slice(4)] = 'absent';
        else if (typeof v === 'string' || typeof v === 'number') filter.ids[k.slice(4)] = String(v);
        else fail(p, 'must be present, absent or a value');
      } else if (k.startsWith('params.')) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') filter.params[k.slice(7)] = String(v);
        else fail(p, 'must be a string or number');
      } else if (k === 'identity.hashesMatch') {
        if (v !== true) fail(p, 'must be true');
        else if (kind === 'mustNot') fail(p, 'is only valid under must');
        else rule.hashesMatch = true;
      } else if (k.startsWith('body.')) {
        const key = k.slice(5);
        if (!(BODY_KEYS as readonly string[]).includes(key)) fail(p, `unknown key, expected one of ${BODY_KEYS.map((b) => `body.${b}`).join(', ')}`);
        else if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x !== '')) fail(p, 'must be a non-empty list of field names');
        else if (v.some((x: string) => x.length > MAX_FIELD_NAME)) fail(p, `field names are at most ${MAX_FIELD_NAME} characters`);
        else if (v.some((x: string) => x === '**.')) fail(p, '"**." needs a name after the dot');
        else (rule.body ??= {})[key as (typeof BODY_KEYS)[number]] = v as string[];
      } else if (k === 'cookie') {
        const l = list(k, v);
        if (l?.some((name) => name.length > MAX_FIELD_NAME)) fail(p, `cookie names are at most ${MAX_FIELD_NAME} characters`);
        else if (l) rule.cookie = l;
      } else if (k === 'vendor') {
        const l = list(k, v, [...vendorKeys, ...trackerVendorKeys, ...extraVendorKeys]);
        if (l) filter.vendor = l;
      } else if (k === 'event' || k === 'transport' || k === 'host') {
        const l = list(k, v);
        if (l) filter[k] = l;
      } else if (k === 'outcome') {
        const l = list(k, v, OUTCOMES);
        if (l) filter.outcome = l as RequestOutcome[];
      } else if (k === 'page') {
        if (typeof v === 'string' && v) filter.page = { equals: v };
        else if (isMap(v) && Object.keys(v).length === 1 && typeof v.matches === 'string') {
          try {
            new RegExp(v.matches);
            filter.page = { matches: v.matches };
          } catch (e) {
            fail(p, `invalid regular expression: ${(e as Error).message}`);
          }
        } else fail(p, 'must be a string or { matches: <regex> }');
      } else if (k === 'count') {
        const c = parseCount(v);
        if (!c) fail(p, 'must be a number or a comparison such as ">=2", "0" or "<3"');
        else if (kind === 'mustNot') fail(p, 'is only valid under must; mustNot means none');
        else rule.count = c;
      } else if (k === 'before') {
        if (v === 'consent') rule.before = 'consent';
        else fail(p, 'must be "consent"');
      } else if (k === 'in') {
        const m = typeof v === 'string' ? /^epoch\(\s*([\w=]+)\s*\)$/.exec(v) : null;
        if (m && validEpochSelector(m[1]!)) rule.inEpoch = m[1]!;
        else fail(p, 'must be epoch(undecided), epoch(granted), epoch(denied), epoch(<field>=<value>) or epoch(label=<label>)');
      } else if (k === 'after') {
        if (typeof v !== 'string' || !v) fail(p, 'must be a step label');
        else if (!stepLabels.has(v)) fail(p, `"${v}" is not a step label, defined labels: ${[...stepLabels].join(', ') || 'none'}`);
        else rule.after = v;
      } else if (VENDOR_KEYS.has(k)) {
        fail(p, 'invalid');
      } else {
        fail(p, 'unknown key');
      }
    }
    if (rule.cookie) {
      const mixed = Object.keys(flat).filter((k) => !COOKIE_RULE_KEYS.includes(k));
      if (mixed.length) fail(path, `cookie cannot be combined with ${mixed.join(', ')}; it only takes before, in and after`);
    }
    if (rule.before && rule.inEpoch) fail(path, 'use either before or in, not both');
    if (rule.body?.has && rule.body.only) fail(path, 'body.has and body.only cannot be in the same entry');
    if (rule.body && rule.hashesMatch) fail(path, 'identity.hashesMatch cannot be combined with body.has or body.only');
    if (rule.body?.ignore && !rule.body.only) fail(path, 'body.ignore is only valid with body.only');
    return issues.length === before ? rule : undefined;
  }

  const options: ScenarioOptions = {};
  if (raw.options !== undefined) {
    if (!isMap(raw.options)) fail(['options'], 'must be a mapping');
    else
      for (const [k, v] of Object.entries(raw.options)) {
        const p = ['options', k];
        if (!OPTION_KEYS.includes(k)) fail(p, `unknown option, expected one of ${OPTION_KEYS.join(', ')}`);
        else if (k === 'network') {
          if (typeof v === 'string' && NETWORKS.includes(v)) options.network = v as NetworkMode;
          else fail(p, `must be one of ${NETWORKS.join(', ')}`);
        } else if (k === 'seed') {
          if (typeof v === 'number' && Number.isInteger(v)) options.seed = v;
          else fail(p, 'must be an integer');
        } else if (k === 'allowUnknownDestination') {
          if (typeof v === 'boolean' || isHostList(v)) options.allowUnknownDestination = v;
          else fail(p, `must be true, false or a list of hosts${HOST_HINT}`);
        } else if (k === 'platformHosts') {
          if (typeof v === 'boolean') options.platformHosts = v;
          else fail(p, 'must be true or false');
        } else if (k === 'cartRequest') {
          if (typeof v === 'string' && v !== '' && isRegExp(v)) options.cartRequest = v;
          else fail(p, 'must be a regular expression such as "/api/cart/add"');
        } else if (k === 'unloadGapIgnore') {
          if (Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')) options.unloadGapIgnore = v as string[];
          else fail(p, 'must be a list of event names or globs such as consent_*');
        } else if (k === 'serverHosts') {
          if (!Array.isArray(v) || v.length === 0 || !v.every(isServerHostPattern)) fail(p, `must be a non-empty list of hosts${HOST_HINT}`);
          else {
            const bad = v.find((host: string) => !isSpecificServerHost(host));
            if (bad !== undefined) fail(p, `"${bad}" is a vendor host or a wildcard on a public suffix. List the server container's own host, such as sgtm.example.com or *.example.com`);
            else options.serverHosts = v as string[];
          }
        } else if (k === 'viewport') {
          if (isMap(v) && Object.keys(v).length === 2 && isViewportSide(v.width) && isViewportSide(v.height)) options.viewport = { width: v.width, height: v.height };
          else fail(p, `must be { width, height }, integers from ${VIEWPORT_MIN} to ${VIEWPORT_MAX}. The preset "mobile" does not exist`);
        } else if (k === 'identifierFields') {
          if (!Array.isArray(v) || v.length === 0 || !v.every((x) => typeof x === 'string' && x !== '')) fail(p, 'must be a non-empty list of field names or globs such as user_data.*');
          else if (v.some((x: string) => x.length > MAX_FIELD_NAME)) fail(p, `field names are at most ${MAX_FIELD_NAME} characters`);
          else options.identifierFields = v as string[];
        } else if (k === 'builtins') {
          if (!isMap(v)) fail(p, `must be a mapping of check name to ${SEVERITIES.join(' or ')}`);
          else {
            const builtins: NonNullable<ScenarioOptions['builtins']> = {};
            for (const [name, severity] of Object.entries(v)) {
              const bp = [...p, name];
              if (!(BUILTIN_NAMES as readonly string[]).includes(name)) fail(bp, `unknown builtin check, expected one of ${BUILTIN_NAMES.join(', ')}`);
              else if (typeof severity !== 'string' || !(SEVERITIES as readonly string[]).includes(severity))
                fail(bp, `must be ${SEVERITIES.join(' or ')}`);
              else builtins[name as BuiltinName] = severity as Severity;
            }
            options.builtins = builtins;
          }
        } else if (k === 'firstPartyHosts') {
          if (isHostList(v)) options.firstPartyHosts = v;
          else fail(p, `must be a list of hosts${HOST_HINT}`);
        } else {
          const ms = parseDuration(v);
          if (ms === undefined) fail(p, 'must be a duration such as 4s or 500ms');
          else if (k === 'consentTimeout') options.consentTimeout = ms;
          else if (k === 'optionalTimeout') {
            if (ms < 100 || ms > 30000) fail(p, 'must be from 100ms to 30s');
            else options.optionalTimeout = ms;
          } else options.graceWindow = ms;
        }
      }
  }

  if (issues.length) throw new ScenarioError(issues);
  return { start, vars, identity, steps, expect: expectOut, options, warnings };
}

const EPOCH_LABELS = ['undecided', 'granted', 'denied', 'mixed', 'withdrawn'];

export function validEpochSelector(selector: string): boolean {
  if (['undecided', 'granted', 'denied'].includes(selector)) return true;
  const m = /^(\w+)=(\w+)$/.exec(selector);
  if (m?.[1] === 'label') return EPOCH_LABELS.includes(m[2]!);
  return !!m && consentFields.includes(m[1] as ConsentField) && CONSENT_VALUES.includes(m[2]!);
}

const RESERVED_EMAIL_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|[^.]+\.(?:test|invalid|example|localhost))$/i;

export const SECRET_FIELD = /card|cvc|cvv|iban|password|cc-/i;
const PHONE_SHAPE = /^(?:\+\d{8,15}|\+?[\d\s]*\(\d{3}\)\s?\d{3}[-.\s]\d{4}|\+?\d{0,3}[-.\s]?\d{3}[-.\s]\d{3}[-.\s]\d{4})$/;

// Digits only, country code first. Ranges set aside for fiction:
// US 555-0100 to 555-0199 (NANPA, https://www.nationalnanpa.com/),
// Sweden 070-174 06 05 to 06 99 (PTS, https://pts.se/),
// UK drama numbers (Ofcom, https://www.ofcom.org.uk/phones-and-broadband/phone-numbers/numbers-for-drama),
// Germany 030 23125 000 to 999 (Bundesnetzagentur, https://www.bundesnetzagentur.de/DE/Fachthemen/Telekommunikation/Nummerierung/DramaNumbers/artikel.html).
const FICTIONAL_PHONE = [
  /^1\d{3}55501\d\d$/,
  /^4670174(?:060[5-9]|06[1-9]\d)$/,
  /^447700900\d{3}$/,
  /^442079460\d{3}$/,
  /^441632960\d{3}$/,
  /^493023125\d{3}$/,
  /^4917139200\d{2}$/,
  /^49176040690\d{2}$/,
  /^44(?:113|114|115|116|117|118|121|131|141|151|161)4960\d{3}$/,
];

function looksLikeRealData(value: string): 'email' | 'phone' | undefined {
  const email = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/.exec(value.trim());
  if (email) return RESERVED_EMAIL_DOMAIN.test(email[1]!) ? undefined : 'email';
  const text = value.trim();
  if (!PHONE_SHAPE.test(text)) return undefined;
  const digits = text.replace(/\D/g, '');
  const international = digits.length > 10 || text.startsWith('+');
  const nationalUs = !international && /^\d{3}55501\d\d$/.test(digits);
  return nationalUs || FICTIONAL_PHONE.some((range) => range.test(digits)) ? undefined : 'phone';
}

const REAL_MOBILE_PREFIX: Record<string, RegExp> = { DE: /^49(?:15|16|17)/, GB: /^447/, SE: /^467/ };
const DIAL_CODE_COUNTRY: [string, string][] = [['49', 'DE'], ['46', 'SE'], ['44', 'GB'], ['1', 'US']];

function phoneWarning(value: string, declaredCountry: string | undefined): string {
  const digits = value.replace(/\D/g, '');
  const international = value.trim().startsWith('+');
  const fromDialCode = international ? DIAL_CODE_COUNTRY.find(([code]) => digits.startsWith(code))?.[1] : undefined;
  const country = fromDialCode ?? (international ? undefined : (declaredCountry?.toUpperCase() ?? 'US'));
  const reasons = ['it is not in a fictional range'];
  if (country && REAL_MOBILE_PREFIX[country]?.test(digits)) reasons.push('its mobile prefix is a real one');
  const hint = country && FICTIONAL_PHONE_HINT[country];
  const range = hint ? `use ${hint}` : 'no fictional range is known for it';
  return `looks like a real phone (${reasons.join(' and ')}${country ? ` for ${country}` : ''}); ${range}`;
}

function realDataWarning(value: string, country: string | undefined): string | undefined {
  const kind = looksLikeRealData(value);
  return kind === 'phone' ? phoneWarning(value, country) : kind && `looks like a real ${kind}`;
}
