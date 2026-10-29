import type { ConsentState, ConsentValue, DataLayerEvent } from '@pingwright/core';

/** A recorded dataLayer event; consent commands look like `['consent', 'update', { analytics_storage: 'granted' }]`. */
export type ConsentPush = Pick<DataLayerEvent, 't' | 'args'>;

export interface ConsentModeChange {
  t: number;
  command: 'default' | 'update';
  /** State after the command, with earlier commands merged in. */
  state: ConsentState;
}

export const unknownConsent: ConsentState = {
  analytics: 'unknown',
  ads: 'unknown',
  adUserData: 'unknown',
  adPersonalization: 'unknown',
};

const signalToField = {
  analytics_storage: 'analytics',
  ad_storage: 'ads',
  ad_user_data: 'adUserData',
  ad_personalization: 'adPersonalization',
} as const satisfies Record<string, keyof ConsentState>;

function toValue(raw: unknown): ConsentValue {
  return raw === 'granted' || raw === 'denied' ? raw : 'unknown';
}

export function consentModeChanges(pushes: readonly ConsentPush[]): ConsentModeChange[] {
  const changes: ConsentModeChange[] = [];
  let state = unknownConsent;
  for (const push of [...pushes].sort((a, b) => a.t - b.t)) {
    if (!Array.isArray(push.args)) continue;
    const [name, command, signals] = push.args;
    if (name !== 'consent' || (command !== 'default' && command !== 'update')) continue;
    if (typeof signals !== 'object' || signals === null) continue;
    const next = { ...state };
    for (const [signal, field] of Object.entries(signalToField)) {
      if (signal in signals) next[field] = toValue((signals as Record<string, unknown>)[signal]);
    }
    state = next;
    changes.push({ t: push.t, command, state });
  }
  return changes;
}
