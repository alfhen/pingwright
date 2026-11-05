import { ga4EventName } from '@tagreeve/decoders';
import type { PushGroup } from './diff.ts';

/** A user map for `diff`: event renames, and key path renames inside one event. Paths are keyed by the event name after the rename. */
export interface EventMap {
  events: Record<string, string>;
  paths: Record<string, Record<string, string>>;
}

const EVENT_NAME = /^[A-Za-z0-9_.: -]{1,200}$/;
const PATH_NAME = /^[A-Za-z0-9_.()[\]*-]{1,200}$/;
const ROOT = '.';
const TOP_KEYS = new Set(['events', 'paths']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parses the text of an event map file. An error names the file and the key, and never a value. */
export function parseEventMap(text: string, file: string): EventMap {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${file}: the event map is not valid JSON.`);
  }
  if (!isRecord(json)) throw new Error(`${file}: the event map must be a JSON object.`);
  for (const key of Object.keys(json)) if (!TOP_KEYS.has(key)) throw new Error(`${file}: unknown key "${key}". Use "events" and "paths".`);
  const map: EventMap = { events: Object.create(null) as Record<string, string>, paths: Object.create(null) as Record<string, Record<string, string>> };
  const events = json.events ?? {};
  if (!isRecord(events)) throw new Error(`${file}: "events" must be an object.`);
  for (const [from, to] of Object.entries(events)) {
    if (!EVENT_NAME.test(from)) throw new Error(`${file}: "events" has a name that is not an event name.`);
    if (typeof to !== 'string' || !EVENT_NAME.test(to)) throw new Error(`${file}: events.${from} must be an event name.`);
    map.events[from] = to;
  }
  const paths = json.paths ?? {};
  if (!isRecord(paths)) throw new Error(`${file}: "paths" must be an object.`);
  for (const [event, renames] of Object.entries(paths)) {
    if (!EVENT_NAME.test(event)) throw new Error(`${file}: "paths" has a name that is not an event name.`);
    if (!isRecord(renames)) throw new Error(`${file}: paths.${event} must be an object.`);
    const out: Record<string, string> = Object.create(null) as Record<string, string>;
    if (Object.hasOwn(renames, ROOT) && Object.keys(renames).length > 1) throw new Error(`${file}: paths.${event} with the "${ROOT}" source key takes no other key.`);
    for (const [from, to] of Object.entries(renames)) {
      if (!PATH_NAME.test(from)) throw new Error(`${file}: paths.${event} has a key that is not a key path.`);
      if (typeof to !== 'string' || (to !== ROOT && !PATH_NAME.test(to))) throw new Error(`${file}: paths.${event}.${from} must be a key path.`);
      if (from === ROOT && to === ROOT) throw new Error(`${file}: paths.${event}.${from} must name a key path to move the root under.`);
      out[from] = to;
    }
    map.paths[event] = out;
  }
  return map;
}

/** The built-in name, for a Shopify standard event. Consent commands and gtag commands keep their labels. */
export function builtInEventName(event: string): string {
  return /^(consent|gtag) /.test(event) ? event : ga4EventName(event);
}

// A rename to "." moves the paths below the source to the root, and drops the source path itself. A rename from "." moves every root path under the target.
function renamePath(path: string, renames: Record<string, string>): string | undefined {
  const bySpecificity = Object.entries(renames).sort(([x], [y]) => y.length - x.length);
  for (const [from, to] of bySpecificity) {
    if (path === from) return to === ROOT ? undefined : to;
    if (path.startsWith(`${from}.`) || path.startsWith(`${from}[`)) {
      const rest = path.slice(from.length);
      return to === ROOT ? rest.replace(/^\./, '') : `${to}${rest}`;
    }
  }
  return path;
}

/** Renames the events and paths of push groups. Groups that end up with the same epoch, event and frame are merged by the comparison. */
export function mapPushGroups(groups: PushGroup[], rename: (event: string) => string, paths: EventMap['paths'] = {}): PushGroup[] {
  return groups.map((g) => {
    const event = rename(g.event);
    const renames = Object.hasOwn(paths, event) ? paths[event]! : undefined;
    if (!renames) return { ...g, event };
    const under = Object.hasOwn(renames, ROOT) ? renames[ROOT]! : undefined;
    if (under !== undefined) {
      // A gtag event push has no `event` key; the object push it maps to has one.
      const moved = g.paths.map((p) => ({ ...p, path: p.path.startsWith('[') ? `${under}${p.path}` : `${under}.${p.path}` }));
      return { ...g, event, paths: g.paths.some((p) => p.path === 'event') ? g.paths : [{ path: 'event', types: ['string'] }, ...moved] };
    }
    // A root rename maps an object push to a gtag event push, which has no `event` key.
    const toGtag = Object.values(renames).includes(ROOT);
    const mapped: PushGroup['paths'] = [];
    for (const p of g.paths) {
      if (toGtag && p.path === 'event') continue;
      const path = renamePath(p.path, renames);
      if (path !== undefined) mapped.push({ ...p, path });
    }
    return { ...g, event, paths: mapped };
  });
}

/** Applies the built-in table, then a user map when there is one. The user map is for the older side of a diff. */
export function normalizePushGroups(groups: PushGroup[], userMap?: EventMap): PushGroup[] {
  const rename = (event: string): string => {
    const user = userMap?.events;
    const named = builtInEventName(event);
    const mapped = user !== undefined && Object.hasOwn(user, event) ? user[event]! : user !== undefined && Object.hasOwn(user, named) ? user[named]! : named;
    return builtInEventName(mapped);
  };
  return mapPushGroups(groups, rename, userMap?.paths);
}
