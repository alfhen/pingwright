import { newId, pageTimeToEpoch, type DataLayerEvent, type EpochMs, type Id } from '@pingwright/core';

export const DATALAYER_BINDING = '__pingwrightDataLayer';

/**
 * Runs in every frame before page scripts. dataLayer may be created before or after this runs,
 * so the property is trapped and an existing array is hooked at once.
 */
export const dataLayerInitScript = `(() => {
  const binding = ${JSON.stringify(DATALAYER_BINDING)};
  const MAX = 10000;
  const clock = () => performance.timeOrigin + performance.now();
  const safe = (args) => {
    try {
      const text = JSON.stringify(args, (k, v) => (typeof v === 'function' || v instanceof Node ? undefined : v));
      return text.length > MAX ? JSON.stringify(['[truncated]']) : text;
    } catch {
      return JSON.stringify(['[unserializable]']);
    }
  };
  const report = (item) => {
    const isArgs = Object.prototype.toString.call(item) === '[object Arguments]';
    const send = window[binding];
    if (typeof send !== 'function') return;
    send({ t: clock(), args: safe(isArgs ? Array.from(item) : [item]) }).catch(() => {});
  };
  const hook = (layer) => {
    if (!Array.isArray(layer) || layer.__pingwrightHooked) return;
    Object.defineProperty(layer, '__pingwrightHooked', { value: true });
    const push = layer.push;
    layer.push = function (...items) {
      for (const item of items) report(item);
      return push.apply(this, items);
    };
    for (const item of layer) report(item);
  };
  let current = window.dataLayer;
  hook(current);
  Object.defineProperty(window, 'dataLayer', {
    configurable: true,
    enumerable: true,
    get: () => current,
    set: (value) => {
      current = value;
      hook(value);
    },
  });
})();`;

export interface DataLayerPayload {
  t: number;
  args: string;
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
  };
}
