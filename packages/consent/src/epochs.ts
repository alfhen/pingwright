import type { ConsentEpoch, ConsentState } from '@pingwright/core';
import { unknownConsent, type ConsentModeChange } from './consent-mode.ts';

export type EpochLabel = 'undecided' | 'granted' | 'denied' | 'mixed';

export interface BannerEvent {
  /** When the action started. */
  t: number;
  /** When the action finished. An update between `t` and `tEnd` starts the epoch at the update. */
  tEnd?: number;
  action: 'accept' | 'reject';
}

/** A ConsentEpoch without its record identity, plus the label that `epoch(<state>)` matches. */
export type EpochDraft = Omit<ConsentEpoch, 'type' | 'id' | 'runId'> & { label: EpochLabel };

export interface EpochOptions {
  /** Start of the run on the shared clock. */
  startT: number;
  /** A Consent Mode update up to this long after a banner event counts as the same change. */
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

/** The latest banner at or before the update, else the earliest one just after it. */
function closestBanner(banners: readonly BannerEvent[], t: number, pairWindowMs: number, leadWindowMs: number): number {
  const before = banners.findLastIndex((b) => b.t <= t && t - b.t <= pairWindowMs);
  if (before >= 0) return before;
  return banners.findIndex((b) => b.t > t && b.t - t <= leadWindowMs);
}

function mergeChanges(
  banners: readonly BannerEvent[],
  updates: readonly ConsentModeChange[],
  pairWindowMs: number,
  leadWindowMs: number,
): Change[] {
  const unpaired = [...banners].sort((a, b) => a.t - b.t);
  const changes: Change[] = [];
  for (const update of updates) {
    const i = closestBanner(unpaired, update.t, pairWindowMs, leadWindowMs);
    const banner = i >= 0 ? unpaired.splice(i, 1)[0] : undefined;
    const label = banner ? labelOf(stateOf(banner.action)) : labelOf(update.state);
    const bannerT = banner ? (banner.tEnd ?? banner.t) : 0;
    if (banner && bannerT < update.t) changes.push({ t: bannerT, source: 'banner', state: update.state, label, decision: true });
    else changes.push({ t: update.t, source: 'consentMode', state: update.state, label, decision: banner !== undefined });
  }
  for (const b of unpaired) changes.push({ t: b.tEnd ?? b.t, source: 'banner', state: stateOf(b.action), label: labelOf(stateOf(b.action)), decision: true });
  return changes.sort((a, b) => a.t - b.t);
}

/**
 * The first epoch is `undecided`; a Consent Mode default sets its state but is not a decision.
 * Each later change starts an epoch at the earlier of the banner event and the Consent Mode
 * update for that change. A Consent Mode update that repeats the state while still undecided,
 * with no banner event behind it, is not a decision.
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
    const sameState = JSON.stringify(current.state) === JSON.stringify(change.state);
    if (sameState && (current.label === label || (current.label === 'undecided' && !change.decision))) continue;
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
