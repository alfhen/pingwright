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
  const post = (payload) => {
    try {
      const send = window[binding];
      if (typeof send !== 'function') return false;
      Promise.resolve(send(payload)).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };
  const argsOf = (item) => safe(Object.prototype.toString.call(item) === '[object Arguments]' ? Array.from(item) : [item]);
  const stampOf = (item) => {
    try {
      const id = item !== null && typeof item === 'object' ? item['gtm.uniqueEventId'] : undefined;
      return typeof id === 'number' ? id : undefined;
    } catch {
      return undefined;
    }
  };
  const defer = queueMicrotask;
  const callIt = Reflect.apply;
  // Nothing here may throw into page code, so every entry point swallows its errors.
  const guarded = (fn) => (...a) => {
    try {
      return fn(...a);
    } catch {
      return undefined;
    }
  };
  const hooks = new WeakMap();
  let reading = false;
  // Page code always sees the function it assigned to push last. Only items appended at the end are recorded:
  // through the base push, which wrappers save and call through, or by length growth for pushes that skip it.
  const hook = (layer, layerName) => {
    if (!Array.isArray(layer)) return;
    const existing = hooks.get(layer);
    if (existing) return existing;
    const info = { a: (seq[layerName] = (seq[layerName] || 0) + 1), posted: 0 };
    let known = 0;
    let prefix = [];
    let queued = false;
    const intact = (length) => {
      try {
        if (length < known) return false;
        for (let i = 0; i < known; i++) if (!Object.is(layer[i], prefix[i])) return false;
        return true;
      } catch {
        return false;
      }
    };
    const resync = (length) => {
      known = length;
      prefix = new Array(length);
      try {
        for (let i = 0; i < length; i++) prefix[i] = layer[i];
      } catch {}
    };
    // A changed slot before the known length means an in-place edit (unshift, splice, sort, shrink): record nothing.
    const fresh = (trusted) => {
      const length = layer.length;
      if (!trusted && !intact(length)) {
        resync(length);
        return [];
      }
      const added = [];
      for (let i = known; i < length; i++) {
        try {
          const present = i in layer;
          const item = layer[i];
          prefix[i] = item;
          if (present) added.push(item);
        } catch {
          prefix[i] = undefined;
        }
      }
      known = length;
      return added;
    };
    // The id is read in a microtask, so an id a wrapper sets after the push returned is picked up.
    const report = (added, t) => {
      const items = [];
      for (const item of added) {
        try {
          items.push({ item, args: argsOf(item) });
        } catch {}
      }
      if (items.length === 0) return;
      info.posted += items.length;
      const at = t === undefined ? clock() : t;
      defer(guarded(() => {
        for (const { item, args } of items) {
          const payload = { t: at, args, uid: stampOf(item), d: token, a: info.a };
          if (layerName !== 'dataLayer') payload.layer = layerName;
          if (!post(payload)) info.posted -= 1;
        }
      }));
    };
    const sync = guarded(() => {
      queued = false;
      report(fresh(false));
    });
    const schedule = guarded(() => {
      if (queued) return;
      queued = true;
      defer(sync);
    });
    const base = Object.prototype.hasOwnProperty.call(layer, 'push') ? Array.prototype.push : layer.push;
    const own = Object.getOwnPropertyDescriptor(layer, 'push');
    const record = function (...items) {
      let t;
      let synced = false;
      try {
        if (this === layer) {
          if (layer.length !== known) sync();
          synced = layer.length === known;
          t = clock();
        }
      } catch {}
      try {
        return callIt(base, this, items);
      } finally {
        try {
          if (this === layer) report(fresh(synced), t);
        } catch {}
      }
    };
    let assigned = own && 'value' in own ? own.value : record;
    const state = { info, sync, schedule };
    hooks.set(layer, state);
    try {
      Object.defineProperty(layer, 'push', {
        configurable: true,
        enumerable: false,
        get: guarded(() => {
          schedule();
          return assigned;
        }),
        set: guarded((fn) => {
          assigned = fn;
          schedule();
        }),
      });
    } catch {}
    try {
      report(fresh(false));
    } catch {}
    return state;
  };
  const current = {};
  const syncAll = guarded(() => {
    for (const name of names) {
      const state = hooks.get(current[name]);
      if (state) state.sync();
    }
  });
  for (const event of ['DOMContentLoaded', 'load', 'pagehide']) {
    try {
      addEventListener(event, syncAll);
    } catch {}
  }
  const trappable = (name) => {
    if (unsafe.includes(name)) return false;
    const found = Object.getOwnPropertyDescriptor(window, name);
    if (!found) return !(name in window);
    return found.configurable === true && 'value' in found && Array.isArray(found.value);
  };
  for (const name of names) {
    if (!trappable(name)) continue;
    current[name] = window[name];
    try {
      hook(current[name], name);
    } catch {}
    Object.defineProperty(window, name, {
      configurable: true,
      enumerable: true,
      get: () => {
        try {
          if (!reading) {
            const state = hooks.get(current[name]);
            if (state) state.schedule();
          }
        } catch {}
        return current[name];
      },
      set: (value) => {
        const previous = current[name];
        current[name] = value;
        try {
          const old = hooks.get(previous);
          if (old) old.sync();
          if (old && name === 'dataLayer' && Array.isArray(value) && value !== previous) post({ t: clock(), args: '[]', reassigned: true });
          hook(value, name);
        } catch {}
      },
    });
  }
  Object.defineProperty(window, ${JSON.stringify(DATALAYER_TALLY)}, {
    value: () => {
      const arrays = [];
      for (const name of names) {
        try {
          let layer;
          reading = true;
          try {
            layer = window[name];
          } finally {
            reading = false;
          }
          if (!Array.isArray(layer)) continue;
          const state = hooks.get(layer);
          if (state) state.sync();
          arrays.push({ layer: name, a: state ? state.info.a : null, length: layer.length, posted: state ? state.info.posted : 0 });
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
  /** `gtm.uniqueEventId`, read after the push returned. */
  uid?: number;
  /** The page replaced `window.dataLayer` with another array. */
  reassigned?: true;
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
  if (!Array.isArray(args) || typeof payload.t !== 'number' || payload.reassigned) return undefined;
  const t: EpochMs = pageTimeToEpoch(payload.t, offset);
  return {
    type: 'dataLayerEvent',
    id: newId('dataLayerEvent'),
    runId,
    stepId: null,
    t,
    event: eventName(args),
    gtmUniqueEventId: typeof payload.uid === 'number' ? payload.uid : uniqueEventId(args),
    args,
    isConsentCommand: isConsentCommand(args),
    frame: { main: frame.main, n: frame.n },
    ...(isDataLayerName(payload.layer) && payload.layer !== DEFAULT_DATALAYER ? { layer: payload.layer } : {}),
  };
}
