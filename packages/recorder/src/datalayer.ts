import { DATALAYER_NAME_PATTERN, NEVER_TRAPPED_NAMES } from '@tagreeve/expect';
import { newId, pageTimeToEpoch, type DataLayerEvent, type DataLayerFrame, type EpochMs, type Id } from '@tagreeve/core';

export const DATALAYER_BINDING = '__tagreeveDataLayer';

export const DEFAULT_DATALAYER = 'dataLayer';

export const DATALAYER_TALLY = '__tagreeveTally';

export function hookedLayerNames(names: readonly string[] = []): string[] {
  return [...new Set([DEFAULT_DATALAYER, ...names.filter((name) => name !== DEFAULT_DATALAYER && isDataLayerName(name))])];
}

/**
 * Runs in every frame before page scripts. A layer may be created before or after this runs,
 * so its property is trapped and an existing array is hooked at once. `dataLayer` is always hooked,
 * then each of `names`.
 */
export function dataLayerInitScript(names: readonly string[] = []): string {
  return `(() => {
  const binding = ${JSON.stringify(DATALAYER_BINDING)};
  const names = ${JSON.stringify(hookedLayerNames(names))};
  const unsafe = ${JSON.stringify(NEVER_TRAPPED_NAMES)};
  const MAX = 10000;
  const token = (() => {
    try {
      return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
    }
  })();
  const infos = new WeakMap();
  const seq = {};
  const clock = () => performance.timeOrigin + performance.now();
  const plain = (k, v) => (typeof v === 'function' || v instanceof Node ? undefined : v);
  // Keeps the top levels, so the event name and ids survive a large push. Deeper values become a marker.
  const shrink = (value, depth, max) => {
    if (typeof value === 'string') return value.length > 500 ? value.slice(0, 500) : value;
    if (typeof value !== 'object' || value === null || value instanceof Node) return value;
    if (depth >= max) return '[truncated]';
    if (Array.isArray(value)) return value.map((item) => shrink(item, depth + 1, max));
    const out = {};
    for (const key of Object.keys(value)) out[key] = shrink(value[key], depth + 1, max);
    return out;
  };
  const safe = (args) => {
    try {
      const text = JSON.stringify(args, plain);
      if (text.length <= MAX) return text;
      for (const max of [6, 4, 3, 2]) {
        const smaller = JSON.stringify(shrink(args, 0, max), plain);
        if (smaller.length <= MAX) return smaller;
      }
      return JSON.stringify(['[truncated]']);
    } catch {
      return JSON.stringify(['[unserializable]']);
    }
  };
  const report = (item, layerName, info) => {
    const isArgs = Object.prototype.toString.call(item) === '[object Arguments]';
    const send = window[binding];
    if (typeof send !== 'function') return;
    const payload = { t: clock(), args: safe(isArgs ? Array.from(item) : [item]), d: token, a: info.a };
    if (layerName !== 'dataLayer') payload.layer = layerName;
    info.posted += 1;
    send(payload).catch(() => {});
  };
  const hook = (layer, layerName) => {
    if (!Array.isArray(layer) || layer.__tagreeveHooked) return;
    Object.defineProperty(layer, '__tagreeveHooked', { value: true });
    seq[layerName] = (seq[layerName] || 0) + 1;
    const info = { a: seq[layerName], posted: 0 };
    infos.set(layer, info);
    const push = layer.push;
    layer.push = function (...items) {
      for (const item of items) report(item, layerName, info);
      return push.apply(this, items);
    };
    for (const item of layer) report(item, layerName, info);
  };
  const trappable = (name) => {
    if (unsafe.includes(name)) return false;
    const found = Object.getOwnPropertyDescriptor(window, name);
    if (!found) return !(name in window);
    return found.configurable === true && 'value' in found && Array.isArray(found.value);
  };
  for (const name of names) {
    if (!trappable(name)) continue;
    let current = window[name];
    hook(current, name);
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = value;
        hook(value, name);
      },
    });
  }
  Object.defineProperty(window, ${JSON.stringify(DATALAYER_TALLY)}, {
    value: () => {
      const arrays = [];
      for (const name of names) {
        try {
          const layer = window[name];
          if (!Array.isArray(layer)) continue;
          const info = infos.get(layer);
          arrays.push({ layer: name, a: info ? info.a : null, length: layer.length, posted: info ? info.posted : 0 });
        } catch {}
      }
      return { d: token, arrays };
    },
  });
})();`;
}

export interface DataLayerPayload {
  t: number;
  args: string;
  layer?: string;
  d?: string;
  a?: number;
}

export function isDataLayerName(name: unknown): name is string {
  return typeof name === 'string' && DATALAYER_NAME_PATTERN.test(name) && !NEVER_TRAPPED_NAMES.includes(name);
}

function isConsentCommand(args: unknown[]): boolean {
  return args[0] === 'consent' && (args[1] === 'default' || args[1] === 'update');
}

function eventName(args: unknown[]): string | null {
  if (args[0] === 'event' && typeof args[1] === 'string') return args[1];
  const first = args[0];
  if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
    const name = (first as Record<string, unknown>).event;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

function uniqueEventId(args: unknown[]): number | null {
  const first = args[0];
  if (typeof first !== 'object' || first === null) return null;
  const id = (first as Record<string, unknown>)['gtm.uniqueEventId'];
  return typeof id === 'number' ? id : null;
}

/** Turns a binding payload into a record. `offset` converts the page clock to the shared clock. */
export function dataLayerEventFromPayload(
  payload: DataLayerPayload,
  runId: Id<'run'>,
  offset: number,
  frame: DataLayerFrame,
): DataLayerEvent | undefined {
  let args: unknown;
  try {
    args = JSON.parse(payload.args);
  } catch {
    return undefined;
  }
  if (!Array.isArray(args) || typeof payload.t !== 'number') return undefined;
  const t: EpochMs = pageTimeToEpoch(payload.t, offset);
  return {
    type: 'dataLayerEvent',
    id: newId('dataLayerEvent'),
    runId,
    stepId: null,
    t,
    event: eventName(args),
    gtmUniqueEventId: uniqueEventId(args),
    args,
    isConsentCommand: isConsentCommand(args),
    frame: { main: frame.main, n: frame.n },
    ...(isDataLayerName(payload.layer) && payload.layer !== DEFAULT_DATALAYER ? { layer: payload.layer } : {}),
  };
}
