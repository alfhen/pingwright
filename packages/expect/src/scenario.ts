import type { ConsentValue, NetworkMode, RequestOutcome } from '@pingwright/core';
import { LineCounter, parseDocument } from 'yaml';

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
}

export type Step =
  | { kind: 'visit'; value: string; line: number }
  | { kind: 'click'; value: string; line: number }
  | { kind: 'fill'; value: Record<string, string>; line: number }
  | { kind: 'consent'; value: 'accept' | 'reject' | 'none' | 'withdraw'; line: number }
  | { kind: 'wait'; value: number; line: number }
  | { kind: 'addToCart'; value: string; line: number }
  | { kind: 'evaluate'; value: string; line: number }
  | { kind: 'checkpoint'; value: string; line: number }
  | { kind: 'handoff'; value: string; line: number };

export interface ScenarioOptions {
  network?: NetworkMode;
  seed?: number;
  consentTimeout?: number;
  graceWindow?: number;
  allowUnknownDestination?: boolean;
}

export interface Scenario {
  start: string;
  vars: Record<string, string>;
  steps: Step[];
  expect: { must: Rule[]; mustNot: Rule[] };
  options: ScenarioOptions;
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
const GROUP_KEYS = ['consent', 'ids', 'params', 'identity'] as const;
const CONSENT_VALUES = ['granted', 'denied', 'unknown'];
const OUTCOMES = ['passed', 'stubbed', 'failed'];
const NETWORKS = ['stub', 'server', 'live'];
const CONSENT_ANSWERS = ['accept', 'reject', 'none', 'withdraw'];
const STEP_KINDS = ['visit', 'click', 'fill', 'consent', 'wait', 'addToCart', 'evaluate', 'checkpoint', 'handoff'];
const TOP_KEYS = ['start', 'vars', 'steps', 'expect', 'options'];
const OPTION_KEYS = ['network', 'seed', 'consentTimeout', 'graceWindow', 'allowUnknownDestination'];

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

export function parseScenario(text: string): Scenario {
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

  const checkVars = (value: string, path: Path) => {
    for (const m of value.matchAll(/\{(\w+)\}/g)) {
      if (!(m[1]! in vars)) fail(path, `uses {${m[1]}} but vars has no "${m[1]}"`);
    }
  };
  if (start) checkVars(start, ['start']);

  const steps: Step[] = [];
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps)) fail(['steps'], 'must be a list');
    else raw.steps.forEach((item, i) => parseStep(item, i));
  }

  function parseStep(item: unknown, i: number) {
    const path: Path = ['steps', i];
    const line = lineOf(path);
    if (!isMap(item) || Object.keys(item).length !== 1) {
      fail(path, `a step is a mapping with exactly one key, one of ${STEP_KINDS.join(', ')}`);
      return;
    }
    const [kind, value] = Object.entries(item)[0]!;
    const str = (): string | undefined => {
      if (typeof value === 'string' && value) return value;
      fail([...path, kind], 'must be a non-empty string');
      return undefined;
    };
    switch (kind) {
      case 'visit': {
        const v = str();
        if (v !== undefined) {
          checkVars(v, [...path, kind]);
          steps.push({ kind, value: v, line });
        }
        return;
      }
      case 'click':
      case 'addToCart':
      case 'evaluate':
      case 'checkpoint':
      case 'handoff': {
        const v = str();
        if (v !== undefined) steps.push({ kind, value: v, line });
        return;
      }
      case 'fill': {
        if (!isMap(value) || Object.keys(value).length === 0) {
          fail([...path, kind], 'must be a mapping of selector to value');
          return;
        }
        const fields: Record<string, string> = {};
        for (const [sel, v] of Object.entries(value)) {
          if (typeof v === 'string' && v) fields[sel] = v;
          else fail([...path, kind, sel], 'must be a non-empty string');
        }
        steps.push({ kind, value: fields, line });
        return;
      }
      case 'consent': {
        if (typeof value === 'string' && CONSENT_ANSWERS.includes(value)) steps.push({ kind, value: value as never, line });
        else fail([...path, kind], `must be one of ${CONSENT_ANSWERS.join(', ')}`);
        return;
      }
      case 'wait': {
        const ms = parseDuration(value);
        if (ms === undefined) fail([...path, kind], 'must be a duration such as 4s, 500ms or 2m');
        else steps.push({ kind, value: ms, line });
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
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') filter.ids[k.slice(4)] = String(v);
        else fail(p, 'must be present, absent or a value');
      } else if (k.startsWith('params.')) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') filter.params[k.slice(7)] = String(v);
        else fail(p, 'must be a string or number');
      } else if (k === 'identity.hashesMatch') {
        if (v !== true) fail(p, 'must be true');
        else if (kind === 'mustNot') fail(p, 'is only valid under must');
        else rule.hashesMatch = true;
      } else if (k === 'vendor' || k === 'event' || k === 'transport' || k === 'host') {
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
        else fail(p, 'must be epoch(undecided), epoch(granted), epoch(denied) or epoch(<field>=<value>)');
      } else if (k === 'after') {
        if (typeof v === 'string' && v) rule.after = v;
        else fail(p, 'must be a step label');
      } else if (VENDOR_KEYS.has(k)) {
        fail(p, 'invalid');
      } else {
        fail(p, 'unknown key');
      }
    }
    if (rule.before && rule.inEpoch) fail(path, 'use either before or in, not both');
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
          if (typeof v === 'boolean') options.allowUnknownDestination = v;
          else fail(p, 'must be true or false');
        } else {
          const ms = parseDuration(v);
          if (ms === undefined) fail(p, 'must be a duration such as 4s or 500ms');
          else if (k === 'consentTimeout') options.consentTimeout = ms;
          else options.graceWindow = ms;
        }
      }
  }

  if (issues.length) throw new ScenarioError(issues);
  return { start, vars, steps, expect: expectOut, options };
}

export function validEpochSelector(selector: string): boolean {
  if (['undecided', 'granted', 'denied'].includes(selector)) return true;
  const m = /^(\w+)=(\w+)$/.exec(selector);
  return !!m && consentFields.includes(m[1] as ConsentField) && CONSENT_VALUES.includes(m[2]!);
}
