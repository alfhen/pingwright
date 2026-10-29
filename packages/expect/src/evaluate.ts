import {
  hashEmail,
  hashPhone,
  newId,
  type ConsentEpoch,
  type ConsentState,
  type ConsentValue,
  type Hit,
  type Identity,
  type PingwrightRecord,
  type Run,
  type Request,
  type Result,
  type Step,
} from '@pingwright/core';
import { isSandboxPageUrl } from '@pingwright/decoders';
import { consentFields, countHolds, describeCount, type ConsentField, type Filter, type Rule, type Scenario } from './scenario.ts';

/** A consent epoch as the evaluator reads it. Unlike the core record, its state may be `undecided`. */
export type EvalEpoch = Omit<ConsentEpoch, 'state'> & { state: ConsentState | 'undecided' };

export interface EvaluateOptions {
  identity?: Identity;
  /** Overrides the scenario option; default 50 ms. */
  graceWindowMs?: number;
}

export const DEFAULT_GRACE_MS = 50;

const GOOGLE_VENDORS = new Set(['ga4', 'google-ads']);

type Input = PingwrightRecord | EvalEpoch;

interface Context {
  hits: Hit[];
  requests: Map<string, Request>;
  epochs: EvalEpoch[];
  steps: Step[];
  grace: number;
  identity?: Identity;
}

export function evaluate(records: readonly Input[], scenario: Scenario, options: EvaluateOptions = {}): Result[] {
  const runRecord = records.find((r): r is Run => r.type === 'run');
  const runId = runRecord?.id ?? records.find((r) => 'runId' in r)?.runId ?? newId('run');
  const ctx: Context = {
    hits: records.filter((r): r is Hit => r.type === 'hit'),
    requests: new Map(records.filter((r): r is Request => r.type === 'request').map((r) => [r.id, r])),
    epochs: records
      .filter((r): r is EvalEpoch => r.type === 'consentEpoch')
      .sort((a, b) => a.startT - b.startT),
    steps: records.filter((r): r is Step => r.type === 'step'),
    grace: options.graceWindowMs ?? scenario.options.graceWindow ?? DEFAULT_GRACE_MS,
    identity: options.identity,
  };

  const results: Result[] = [];
  const add = (expectation: string, pass: boolean, evidence: string[], message: string) =>
    results.push({ type: 'result', id: newId('result'), runId, expectation, pass, evidence, message });

  for (const kind of ['mustNot', 'must'] as const)
    for (const rule of scenario.expect[kind]) {
      const { pass, evidence, message } = evaluateRule(rule, ctx);
      add(`${kind}: ${rule.description}`, pass, evidence, message);
    }

  builtInChecks(records, scenario, ctx, add);
  return results;
}

function evaluateRule(rule: Rule, ctx: Context): { pass: boolean; evidence: string[]; message: string } {
  let hits = ctx.hits.filter((h) => matchesFilter(h, rule.filter, ctx));
  const total = hits.length;
  const narrowed: string[] = [];

  if (rule.before) {
    hits = hits.filter((h) => isBeforeConsent(h, ctx));
    narrowed.push('before consent');
  }
  if (rule.inEpoch) {
    const selector = rule.inEpoch;
    hits = hits.filter((h) => inEpoch(h, selector, ctx));
    narrowed.push(`in epoch(${selector})`);
  }
  if (rule.after) {
    const step = ctx.steps.find((s) => s.label === rule.after);
    if (!step) {
      const known = ctx.steps.map((s) => s.label).join(', ') || 'none';
      return { pass: false, evidence: [], message: `Expected a step labelled "${rule.after}", but the run has steps: ${known}.` };
    }
    const from = step.endedAt ?? step.startedAt;
    hits = hits.filter((h) => h.t >= from);
    narrowed.push(`after ${rule.after}`);
  }

  const where = narrowed.length ? ` ${narrowed.join(', ')}` : '';
  const ids = hits.map((h) => h.id);
  const found = `found ${hits.length} matching hit${hits.length === 1 ? '' : 's'}${narrowed.length ? ` (${total} before narrowing)` : ''}`;

  if (rule.kind === 'mustNot') {
    return {
      pass: hits.length === 0,
      evidence: ids,
      message: hits.length === 0 ? `Expected no matching hits${where}, found none.` : `Expected no matching hits${where}, ${found}.`,
    };
  }

  const count = rule.count ?? { op: '>=' as const, n: 1 };
  let pass = countHolds(count, hits.length);
  let message = `Expected ${describeCount(count)} matching hits${where}, ${found}.`;
  if (pass && rule.hashesMatch) {
    const check = checkHashes(hits, ctx);
    pass = check.pass;
    message += ` ${check.message}`;
    return { pass, evidence: check.evidence, message };
  }
  return { pass, evidence: ids, message };
}

function matchesFilter(hit: Hit, f: Filter, ctx: Context): boolean {
  if (f.vendor && !f.vendor.includes(hit.vendor)) return false;
  if (f.event && (hit.event === null || !f.event.includes(hit.event))) return false;
  for (const field of consentFields) {
    const want = f.consent[field];
    if (want && hit.consent[field] !== want) return false;
  }
  for (const [name, want] of Object.entries(f.ids)) {
    const have = hit.ids[name];
    const present = have !== undefined && have !== false;
    if (want === 'present') {
      if (!present) return false;
    } else if (want === 'absent') {
      if (present) return false;
    } else if (String(have) !== want) return false;
  }
  if (f.page) {
    if (hit.page === null) return false;
    if ('equals' in f.page ? hit.page !== f.page.equals : !new RegExp(f.page.matches).test(hit.page)) return false;
  }
  if (f.transport && !f.transport.includes(hit.transport)) return false;
  for (const [name, want] of Object.entries(f.params)) if (hit.params[name] !== want) return false;
  if (f.host || f.outcome) {
    const request = ctx.requests.get(hit.requestId);
    if (!request) return false;
    if (f.host && !f.host.includes(hostOf(request.url))) return false;
    if (f.outcome && !f.outcome.includes(request.outcome)) return false;
  }
  return true;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function judgedByHit(hit: Hit): boolean {
  return GOOGLE_VENDORS.has(hit.vendor) && consentFields.some((f) => hit.consent[f] !== 'unknown');
}

/**
 * The epoch a hit belongs to. A hit within the grace window before a boundary belongs to the new
 * epoch, since tags may fire on the consent update itself.
 */
function epochOf(hit: Hit, ctx: Context): EvalEpoch | undefined {
  let found: EvalEpoch | undefined;
  ctx.epochs.forEach((e, i) => {
    const start = i === 0 ? -Infinity : e.startT - ctx.grace;
    if (hit.t >= start) found = e;
  });
  return found;
}

function stateMatches(state: ConsentState | 'undecided', selector: string): boolean {
  if (state === 'undecided') return selector === 'undecided';
  if (selector === 'undecided') return false;
  if (selector === 'granted' || selector === 'denied') {
    const known = consentFields.map((f) => state[f]).filter((v) => v !== 'unknown');
    return known.length > 0 && known.every((v) => v === selector);
  }
  const [field, value] = selector.split('=') as [ConsentField, ConsentValue];
  return state[field] === value;
}

/** Google hits carry no undecided state, so `undecided` means no field is granted. */
function hitConsentMatches(hit: Hit, selector: string): boolean {
  if (selector === 'undecided') return consentFields.every((f) => hit.consent[f] !== 'granted');
  return stateMatches(hit.consent, selector);
}

function isBeforeConsent(hit: Hit, ctx: Context): boolean {
  if (judgedByHit(hit)) return hitConsentMatches(hit, 'undecided');
  const epoch = epochOf(hit, ctx);
  return !epoch || (epoch === ctx.epochs[0] && epoch.state === 'undecided');
}

function inEpoch(hit: Hit, selector: string, ctx: Context): boolean {
  if (judgedByHit(hit)) return hitConsentMatches(hit, selector);
  const epoch = epochOf(hit, ctx);
  if (!epoch) return selector === 'undecided';
  return stateMatches(epoch.state, selector);
}

function hashForms(identity: Identity): Set<string> {
  const out = new Set<string>();
  for (const h of [hashEmail(identity.email), hashPhone(identity.phone)]) {
    out.add(h.hex);
    out.add(h.base64);
    out.add(h.base64url);
  }
  return out;
}

const LOOKS_HASHED = /^(?:[0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?)$/;

function checkHashes(hits: Hit[], ctx: Context): { pass: boolean; evidence: string[]; message: string } {
  if (!ctx.identity) return { pass: false, evidence: [], message: 'Cannot check hashes: no run identity was given.' };
  const known = hashForms(ctx.identity);
  const withHash: string[] = [];
  const wrong: string[] = [];
  for (const hit of hits) {
    const hashed = Object.entries(hit.params).filter(([, v]) => LOOKS_HASHED.test(v));
    if (hashed.length) withHash.push(hit.id);
    if (hashed.some(([, v]) => !known.has(v))) wrong.push(hit.id);
  }
  if (wrong.length) {
    return { pass: false, evidence: wrong, message: `Hashed values in ${wrong.length} hit(s) do not match the run identity.` };
  }
  if (!withHash.length) {
    return { pass: false, evidence: [], message: 'Expected hashed email or phone values matching the run identity, found no hashed values.' };
  }
  return { pass: true, evidence: withHash, message: `Hashed values in ${withHash.length} hit(s) match the run identity.` };
}

function builtInChecks(
  records: readonly Input[],
  scenario: Scenario,
  ctx: Context,
  add: (expectation: string, pass: boolean, evidence: string[], message: string) => void,
) {
  const flags = records.filter((r) => r.type === 'flag');

  const unknown = flags.filter((f) => f.kind === 'unknownDestination');
  if (scenario.options.allowUnknownDestination) {
    add('builtin: unknownDestination', true, unknown.map((f) => f.id), `Unknown destinations allowed by the scenario; ${unknown.length} flagged.`);
  } else {
    add(
      'builtin: unknownDestination',
      unknown.length === 0,
      unknown.flatMap((f) => [f.id, ...f.recordIds]),
      unknown.length === 0
        ? 'Expected no requests to unknown destinations, found none.'
        : `Expected no requests to unknown destinations, found ${unknown.length}: ${unknown.map((f) => f.detail).join('; ')}.`,
    );
  }

  const sandboxed = ctx.hits.filter((h) => isSandboxPageUrl(h.page));
  add(
    'builtin: sandboxPageUrl',
    sandboxed.length === 0,
    sandboxed.map((h) => h.id),
    sandboxed.length === 0
      ? 'Expected no hit to carry a sandbox URL as its page, found none.'
      : `Expected no hit to carry a sandbox URL as its page, found ${sandboxed.length}: ${sandboxed[0]!.page}.`,
  );

  const real = flags.filter((f) => f.kind === 'possibleRealData');
  add(
    'builtin: possibleRealData',
    real.length === 0,
    real.flatMap((f) => [f.id, ...f.recordIds]),
    real.length === 0
      ? 'Expected no data that is not from the run identity, found none.'
      : `Expected no data that is not from the run identity, found ${real.length} flag(s): ${real.map((f) => f.detail).join('; ')}.`,
  );
}
