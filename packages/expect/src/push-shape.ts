import type { DataLayerEvent, Step } from '@tagreeve/core';
import { guardFieldName, isValueSegment, OTHER_NAME } from '@tagreeve/decoders';

export type PushFrameKind = 'main' | 'embedded' | 'unknown';

export interface PushPath {
  path: string;
  types: string[];
}

export interface PushShape {
  event: string;
  frame: PushFrameKind;
  count: number;
  paths: PushPath[];
  ids: string[];
}

export interface StepPushShapes {
  step: string;
  events: PushShape[];
}

export interface PushShapes {
  pushes: number;
  steps: StepPushShapes[];
}

export const NO_EVENT = '(no event)';
const NO_STEP = '(no step)';
const EVENT_CHARS = /^[A-Za-z0-9_.:-]+$/;
const MAX_DEPTH = 8;
const MAX_PATHS = 200;

function safeName(name: string): string {
  return EVENT_CHARS.test(name) && !isValueSegment(name) && guardFieldName(name) === name ? name : OTHER_NAME;
}

function safeKey(key: string): string {
  return guardFieldName(key) === key && !isValueSegment(key) ? key : OTHER_NAME;
}

function typeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

function walk(value: unknown, path: string, depth: number, out: Map<string, Set<string>>): void {
  const children: [string, unknown][] =
    typeof value !== 'object' || value === null ? [] : Array.isArray(value) ? value.map((v) => ['[*]', v]) : Object.entries(value);
  if (children.length === 0 || depth >= MAX_DEPTH) {
    if (path === '' || (!out.has(path) && out.size >= MAX_PATHS)) return;
    (out.get(path) ?? out.set(path, new Set()).get(path)!).add(typeOf(value));
    return;
  }
  for (const [key, child] of children) {
    walk(child, key === '[*]' ? `${path}[*]` : path === '' ? safeKey(key) : `${path}.${safeKey(key)}`, depth + 1, out);
  }
}

function isGtagCommand(args: unknown[]): args is [string, ...unknown[]] {
  return typeof args[0] === 'string';
}

function eventLabel(e: DataLayerEvent): string {
  if (e.isConsentCommand) return `consent ${String(e.args[1])}`;
  if (e.event !== null) return safeName(e.event);
  return isGtagCommand(e.args) ? `gtag ${safeName(e.args[0])}` : NO_EVENT;
}

function frameKind(e: DataLayerEvent): PushFrameKind {
  return e.frame === undefined ? 'unknown' : e.frame.main ? 'main' : 'embedded';
}

// gtm.* pushes are counts only, and a consent command keeps its signal names without the granted or denied values.
function collectPaths(e: DataLayerEvent, into: Map<string, Set<string>>): void {
  if (e.event?.startsWith('gtm.')) return;
  if (e.isConsentCommand) {
    const signals = e.args[2];
    if (typeof signals === 'object' && signals !== null) for (const [name, value] of Object.entries(signals)) walk(value, safeKey(name), 0, into);
    return;
  }
  if (isGtagCommand(e.args)) {
    for (const arg of e.args.slice(e.args[0] === 'set' ? 1 : 2)) walk(arg, '', 0, into);
    return;
  }
  for (const arg of e.args) walk(arg, '', 0, into);
}

/** Shapes of the pushes per step, event name and frame: key paths and types only. No value is read into the result, and a key or event name that looks like a value reads `(other)`. */
export function pushShapes(records: { steps?: readonly Step[]; dataLayerEvents: readonly DataLayerEvent[] }): PushShapes {
  const labels = new Map((records.steps ?? []).map((s) => [s.id as string, s.label]));
  const steps = new Map<string, Map<string, { shape: PushShape; types: Map<string, Set<string>> }>>();
  for (const e of records.dataLayerEvents) {
    const step = e.stepId === null ? NO_STEP : (labels.get(e.stepId) ?? NO_STEP);
    const event = eventLabel(e);
    const frame = frameKind(e);
    const groups = steps.get(step) ?? steps.set(step, new Map()).get(step)!;
    const key = JSON.stringify([event, frame]);
    const group = groups.get(key) ?? groups.set(key, { shape: { event, frame, count: 0, paths: [], ids: [] }, types: new Map() }).get(key)!;
    group.shape.count += 1;
    group.shape.ids.push(e.id);
    collectPaths(e, group.types);
  }
  return {
    pushes: records.dataLayerEvents.length,
    steps: [...steps].map(([step, groups]) => ({
      step,
      events: [...groups.values()].map(({ shape, types }) => ({
        ...shape,
        paths: [...types].map(([path, set]) => ({ path, types: [...set].sort() })),
      })),
    })),
  };
}
