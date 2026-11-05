import { newId, pageTimeToEpoch, type DataLayerEvent, type DataLayerFrame, type EpochMs, type Id } from '@tagreeve/core';

export const DATALAYER_BINDING = '__tagreeveDataLayer';

/**
 * Runs in every frame before page scripts. dataLayer may be created before or after this runs,
 * so the property is trapped and an existing array is hooked at once.
 */
export const dataLayerInitScript = `(() => {
  const binding = ${JSON.stringify(DATALAYER_BINDING)};
  const MAX = 10000;
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
  const post = (message) => {
    const send = window[binding];
    if (typeof send !== 'function') return;
    send(message).catch(() => {});
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
  const hook = (layer) => {
    if (!Array.isArray(layer) || layer.__tagreeveHooked) return;
    try {
      Object.defineProperty(layer, '__tagreeveHooked', { value: true });
    } catch {
      return;
    }
    // Each entry runs its own implementation, so a saved push reaches the same one whenever it is called, in any
    // unwrap order. The first entry that sees an item reports it, so a push is recorded once however wrappers call
    // each other. Primitives cannot be tracked and are reported at the outermost call only.
    const seen = new WeakSet();
    let depth = 0;
    const entryFor = (impl, base) =>
      function (...items) {
        const fresh = items.filter((item) => {
          if (item !== null && (typeof item === 'object' || typeof item === 'function')) {
            if (seen.has(item)) return false;
            seen.add(item);
            return true;
          }
          return depth === 0;
        });
        const started = fresh.map((item) => ({ item, t: clock(), args: argsOf(item) }));
        depth++;
        try {
          return impl.apply(this, items);
        } finally {
          depth--;
          if (base) for (const item of items) if (item !== null && (typeof item === 'object' || typeof item === 'function')) seen.delete(item);
          for (const { item, t, args } of started) post({ t, args, uid: stampOf(item) });
        }
      };
    const known = new Set();
    let top = entryFor(layer.push, true);
    known.add(top);
    try {
      Object.defineProperty(layer, 'push', {
        configurable: true,
        enumerable: false,
        get: () => top,
        set: (fn) => {
          if (typeof fn !== 'function') return;
          if (!known.has(fn)) {
            const entry = entryFor(fn, false);
            known.add(entry);
            top = entry;
            return;
          }
          top = fn;
        },
      });
    } catch {
      try {
        layer.push = top;
      } catch {}
    }
    for (const item of layer) post({ t: clock(), args: argsOf(item), uid: stampOf(item) });
  };
  let current = window.dataLayer;
  hook(current);
  Object.defineProperty(window, 'dataLayer', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value) => {
      const previous = current;
      current = value;
      if (Array.isArray(previous) && previous.__tagreeveHooked && Array.isArray(value) && value !== previous) {
        post({ t: clock(), args: '[]', reassigned: true });
      }
      hook(value);
    },
  });
})();`;

export interface DataLayerPayload {
  t: number;
  args: string;
  /** `gtm.uniqueEventId`, read after the push returned. */
  uid?: number;
  /** The page replaced `window.dataLayer` with another array. */
  reassigned?: true;
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
  };
}
