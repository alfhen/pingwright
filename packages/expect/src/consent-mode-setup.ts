import type { DataLayerEvent, Hit } from '@tagreeve/core';
import { GCD_SIGNALS, gcdSignals, type GcdSignalName } from '@tagreeve/decoders';

export const CONSENT_MODE_URL = 'https://developers.google.com/tag-platform/security/guides/consent';

const GOOGLE_VENDORS = new Set(['ga4', 'google-ads']);
const TAG_ID = /^[A-Za-z]{1,3}-[A-Za-z0-9]{4,20}$/;
const MAX_LISTED = 5;

export interface ConsentModeSetup {
  pass: boolean;
  evidence: string[];
  message: string;
}

function tagId(hit: Hit): string {
  const tid = hit.params.tid;
  return tid && TAG_ID.test(tid) ? tid : '(no tag ID)';
}

function list(names: readonly string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Judges Google hits by their own `gcd`. The caller leaves out server container hits: their consent signals come from the browser hit they link to. */
export function consentModeSetup(hits: readonly Hit[], dataLayer: readonly DataLayerEvent[]): ConsentModeSetup {
  const google = hits.filter((h) => GOOGLE_VENDORS.has(h.vendor));
  if (google.length === 0) return { pass: true, evidence: [], message: 'Expected Consent Mode signals to be set on Google hits, found no Google hits.' };

  const unset = new Map<string, Set<GcdSignalName>>();
  const v1Only = new Set<string>();
  const evidence: string[] = [];
  let showsDefault = false;
  for (const hit of google) {
    const signals = gcdSignals(hit.consent.raw.gcd);
    if (!signals) continue;
    const hasDefault = GCD_SIGNALS.some((n) => {
      const s = signals[n];
      return !s.notSet && s.default !== 'unknown';
    });
    if (hasDefault) showsDefault = true;
    const missing = GCD_SIGNALS.filter((n) => signals[n].notSet);
    if (missing.length === 0) continue;
    const tid = tagId(hit);
    evidence.push(hit.id);
    const names = unset.get(tid) ?? new Set<GcdSignalName>();
    for (const n of missing) names.add(n);
    unset.set(tid, names);
    const v1Default = [signals.ad_storage, signals.analytics_storage].every((s) => !s.notSet && s.default !== 'unknown');
    if (v1Default && signals.ad_user_data.notSet && signals.ad_personalization.notSet) v1Only.add(tid);
  }

  if (unset.size > 0) {
    const groups = [...unset].map(([tid, names]) => {
      const ordered = GCD_SIGNALS.filter((n) => names.has(n));
      const note = v1Only.has(tid) ? ' (a default for ad_storage and analytics_storage only, without the two v2 signals)' : '';
      return `Google tag ${tid} never set ${list(ordered)}${note}`;
    });
    const shown = groups.slice(0, MAX_LISTED).join('; ');
    const more = groups.length > MAX_LISTED ? `; and ${groups.length - MAX_LISTED} more` : '';
    return {
      pass: false,
      evidence,
      message: `${evidence.length} Google hit${evidence.length === 1 ? '' : 's'} show a Consent Mode signal that was never set: ${shown}${more}. See ${CONSENT_MODE_URL}`,
    };
  }

  const pushed = dataLayer.some((e) => e.isConsentCommand && e.args[0] === 'consent' && e.args[1] === 'default');
  if (showsDefault && !pushed) {
    return { pass: true, evidence: [], message: 'Consent Mode signals are set on every Google hit; default set outside the dataLayer (template API, TCF or other).' };
  }
  return { pass: true, evidence: [], message: 'Expected Consent Mode signals to be set on Google hits, found every signal set.' };
}
