import type { ConsentEpoch, ConsentState } from '@pingwright/core';
import { unknownConsent, type ConsentModeChange } from './consent-mode.ts';

export type EpochLabel = ConsentEpoch['label'];

export interface BannerEvent {
  /** When the action started. */
  t: number;
  /** When the action finished. An update between `t` and `tEnd` starts the epoch at the update. */
  tEnd?: number;
  action: 'accept' | 'reject';
}

export type EpochDraft = Omit<ConsentEpoch, 'type' | 'id' | 'runId'>;

export interface EpochOptions {
  /** Start of the run on the shared clock. */
  startT: number;
  /** A Consent Mode update up to this long after a banner action ends counts as the same change. */
  pairWindowMs?: number;
  /** A Consent Mode update up to this long before a banner event counts as the same change. */
  leadWindowMs?: number;
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
  label: EpochLabel;
  /** Backed by a banner event, so it is a visitor decision even when the state does not change. */
  decision: boolean;
}

/** The latest banner that started at or before the update and whose window is still open, else the earliest one just after it. */
function bannerFor(banners: readonly BannerEvent[], t: number, pairWindowMs: number, leadWindowMs: number): number {
  const before = banners.findLastIndex((b) => b.t <= t && t <= (b.tEnd ?? b.t) + pairWindowMs);
  if (before >= 0) return before;
  return banners.findIndex((b) => b.t > t && b.t - t <= leadWindowMs);
}

function mergeChanges(
  banners: readonly BannerEvent[],
  updates: readonly ConsentModeChange[],
  pairWindowMs: number,
  leadWindowMs: number,
): Change[] {
  const sortedBanners = [...banners].sort((a, b) => a.t - b.t);
  const owned = sortedBanners.map(() => [] as ConsentModeChange[]);
  const changes: Change[] = [];
  for (const update of updates) {
    const i = bannerFor(sortedBanners, update.t, pairWindowMs, leadWindowMs);
    if (i >= 0) owned[i]!.push(update);
    else changes.push({ t: update.t, source: 'consentMode', state: update.state, label: labelOf(update.state), decision: false });
  }
  sortedBanners.forEach((banner, i) => {
    const own = owned[i]!;
    const bannerT = banner.tEnd ?? banner.t;
    const firstUpdateT = own[0]?.t ?? Infinity;
    changes.push({
      t: Math.min(bannerT, firstUpdateT),
      source: firstUpdateT < bannerT ? 'consentMode' : 'banner',
      state: own[own.length - 1]?.state ?? stateOf(banner.action),
      label: labelOf(stateOf(banner.action)),
      decision: true,
    });
  });
  return changes.sort((a, b) => a.t - b.t);
}

/**
 * The first epoch is `undecided`; a Consent Mode default sets its state but is not a decision.
 * Each banner action defines a window [t - lead, tEnd + after]. Consent Mode updates inside it
 * belong to that decision. Its epoch starts at the earliest of the action end and those updates,
 * is labelled by the action, and takes the last Consent Mode state in the window (the action's
 * own state when no update came). Updates outside every window that change state start their
 * own epoch with source consentMode. While undecided, such an update that grants nothing only
 * updates the undecided state and starts no epoch.
 */
export function buildEpochs(
  banners: readonly BannerEvent[],
  modeChanges: readonly ConsentModeChange[],
  options: EpochOptions,
): EpochDraft[] {
  const sorted = [...modeChanges].sort((a, b) => a.t - b.t);
  const updates = sorted.filter((c) => c.command === 'update');
  const firstDecisionT = Math.min(updates[0]?.t ?? Infinity, ...banners.map((b) => b.t));
  const initial = sorted.findLast((c) => c.command === 'default' && c.t < firstDecisionT)?.state ?? unknownConsent;
  const epochs: EpochDraft[] = [
    { startT: options.startT, endT: null, source: 'start', state: initial, label: 'undecided' },
  ];
  for (const change of mergeChanges(banners, updates, options.pairWindowMs ?? DEFAULT_PAIR_WINDOW_MS, options.leadWindowMs ?? DEFAULT_GRACE_MS)) {
    const current = epochs[epochs.length - 1]!;
    const label = change.label;
    if (current.label === 'undecided' && !change.decision && !Object.values(change.state).includes('granted')) {
      current.state = change.state;
      continue;
    }
    const sameState = JSON.stringify(current.state) === JSON.stringify(change.state);
    if (!change.decision && sameState) continue;
    if (sameState && current.label === label) continue;
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
