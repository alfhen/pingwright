import type { ConsentEpoch, ConsentState } from '@pingwright/core';
import { unknownConsent, type ConsentModeChange } from './consent-mode.ts';

export type EpochLabel = 'undecided' | 'granted' | 'denied' | 'mixed';

export interface BannerEvent {
  t: number;
  action: 'accept' | 'reject';
}

/** A ConsentEpoch without its record identity, plus the label that `epoch(<state>)` matches. */
export type EpochDraft = Omit<ConsentEpoch, 'type' | 'id' | 'runId'> & { label: EpochLabel };

export interface EpochOptions {
  /** Start of the run on the shared clock. */
  startT: number;
  /** A banner event and a Consent Mode update this close count as the same change. */
  pairWindowMs?: number;
}

export const DEFAULT_GRACE_MS = 50;
const DEFAULT_PAIR_WINDOW_MS = 2000;

export function labelOf(state: ConsentState): EpochLabel {
  const values = Object.values(state);
  if (values.every((v) => v === 'granted')) return 'granted';
  if (values.every((v) => v === 'denied')) return 'denied';
  return 'mixed';
}

function stateOf(action: BannerEvent['action']): ConsentState {
  const v = action === 'accept' ? 'granted' : 'denied';
  return { analytics: v, ads: v, adUserData: v, adPersonalization: v };
}

interface Change {
  t: number;
  source: 'banner' | 'consentMode';
  state: ConsentState;
}

function mergeChanges(
  banners: readonly BannerEvent[],
  updates: readonly ConsentModeChange[],
  pairWindowMs: number,
): Change[] {
  const unpaired = [...banners].sort((a, b) => a.t - b.t);
  const changes: Change[] = [];
  for (const update of updates) {
    const label = labelOf(update.state);
    const i = unpaired.findIndex((b) => labelOf(stateOf(b.action)) === label && Math.abs(b.t - update.t) <= pairWindowMs);
    const banner = i >= 0 ? unpaired.splice(i, 1)[0] : undefined;
    if (banner && banner.t < update.t) changes.push({ t: banner.t, source: 'banner', state: update.state });
    else changes.push({ t: update.t, source: 'consentMode', state: update.state });
  }
  for (const b of unpaired) changes.push({ t: b.t, source: 'banner', state: stateOf(b.action) });
  return changes.sort((a, b) => a.t - b.t);
}

/**
 * The first epoch is `undecided`; a Consent Mode default sets its state but is not a decision.
 * Each later change starts an epoch at the earlier of the banner event and the Consent Mode
 * update for that change.
 */
export function buildEpochs(
  banners: readonly BannerEvent[],
  modeChanges: readonly ConsentModeChange[],
  options: EpochOptions,
): EpochDraft[] {
  const sorted = [...modeChanges].sort((a, b) => a.t - b.t);
  const initial = sorted.find((c) => c.command === 'default')?.state ?? unknownConsent;
  const updates = sorted.filter((c) => c.command === 'update');
  const epochs: EpochDraft[] = [
    { startT: options.startT, endT: null, source: 'start', state: initial, label: 'undecided' },
  ];
  for (const change of mergeChanges(banners, updates, options.pairWindowMs ?? DEFAULT_PAIR_WINDOW_MS)) {
    const current = epochs[epochs.length - 1]!;
    const label = labelOf(change.state);
    if (current.label === label && JSON.stringify(current.state) === JSON.stringify(change.state)) continue;
    current.endT = change.t;
    epochs.push({ startT: change.t, endT: null, source: change.source, state: change.state, label });
  }
  return epochs;
}

/**
 * The epochs a non-Google hit may be judged by. A hit within the grace window after an epoch
 * starts also matches the epoch before it, because tags can fire on the update event itself.
 */
export function epochsForHit(epochs: readonly EpochDraft[], t: number, graceMs = DEFAULT_GRACE_MS): EpochDraft[] {
  const i = epochs.findLastIndex((e) => e.startT <= t);
  if (i < 0) return [];
  const found = [epochs[i]!];
  if (i > 0 && t - epochs[i]!.startT < graceMs) found.unshift(epochs[i - 1]!);
  return found;
}
