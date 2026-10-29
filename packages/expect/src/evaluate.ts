import {
  hashEmail,
  hashPhone,
  scan,
  sha256,
  newId,
  type ConsentEpoch,
  type ConsentState,
  type ConsentValue,
  type HashForms,
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
    identity: options.identity ?? identityOf(runRecord),
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
  const effective = effectiveConsent(hit, ctx);
  for (const field of consentFields) {
    const want = f.consent[field];
    if (want && effective[field] !== want) return false;
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

/**
 * Google hits state their own consent for every field they carry; every other field, and every other
 * vendor, takes the state of the epoch the hit falls in.
 */
function effectiveConsent(hit: Hit, ctx: Context): ConsentState {
  const epochState = epochOf(hit, ctx)?.state;
  const base = epochState && epochState !== 'undecided' ? epochState : undefined;
  const own = GOOGLE_VENDORS.has(hit.vendor);
  const pick = (f: ConsentField): ConsentValue => {
    const carried = hit.consent[f];
    if (own && carried !== 'unknown') return carried;
    return base ? base[f] : 'unknown';
  };
  return {
    analytics: pick('analytics'),
    ads: pick('ads'),
    adUserData: pick('adUserData'),
    adPersonalization: pick('adPersonalization'),
  };
}

function stateMatches(state: ConsentState, selector: string): boolean {
  if (selector === 'undecided') return false;
  if (selector === 'granted' || selector === 'denied') {
    const known = consentFields.map((f) => state[f]).filter((v) => v !== 'unknown');
    return known.length > 0 && known.every((v) => v === selector);
  }
  const [field, value] = selector.split('=') as [ConsentField, ConsentValue];
  return state[field] === value;
}

/** Timing decides this for every vendor: what a hit carries cannot show that the visitor had not yet answered. */
function inUndecidedEpoch(hit: Hit, ctx: Context): boolean {
  const epoch = epochOf(hit, ctx);
  return !epoch || epoch.state === 'undecided';
}

function isBeforeConsent(hit: Hit, ctx: Context): boolean {
  const epoch = epochOf(hit, ctx);
  return !epoch || (epoch === ctx.epochs[0] && epoch.state === 'undecided');
}

function inEpoch(hit: Hit, selector: string, ctx: Context): boolean {
  if (selector === 'undecided') return inUndecidedEpoch(hit, ctx);
  return stateMatches(effectiveConsent(hit, ctx), selector);
}

const EMAIL_PARAM = /^(?:em|ud\[em\]|hashedEmail|sha256_email_address)$/;
const PHONE_PARAM = /^(?:ph|ud\[ph\]|hashedPhone|sha256_phone_number)$/;

function allForms(h: HashForms): string[] {
  return [h.hex, h.base64, h.base64url];
}

function checkHashes(hits: Hit[], ctx: Context): { pass: boolean; evidence: string[]; message: string } {
  const identity = ctx.identity;
  if (!identity) return { pass: false, evidence: [], message: 'Cannot check hashes: no run identity was given.' };
  const emailHashes = new Set(allForms(hashEmail(identity.email)));
  const phone = hashPhone(identity.phone);
  const phoneHashes = new Set([...allForms(phone), ...allForms(sha256(identity.phone.replace(/\D/g, '')))]);
  const plain = new Set([identity.email.toLowerCase(), identity.phone.toLowerCase(), identity.phone.replace(/\D/g, '')]);
  const withHash: string[] = [];
  const wrong: string[] = [];
  const unhashed: string[] = [];
  for (const hit of hits) {
    let seen = false;
    let bad = false;
    let raw = false;
    for (const [name, value] of Object.entries(hit.params)) {
      const known = EMAIL_PARAM.test(name) ? emailHashes : PHONE_PARAM.test(name) ? phoneHashes : undefined;
      if (!known || !value) continue;
      seen = true;
      if (known.has(value)) continue;
      bad = true;
      if (plain.has(value.trim().toLowerCase())) raw = true;
    }
    if (seen) withHash.push(hit.id);
    if (bad) wrong.push(hit.id);
    if (raw) unhashed.push(hit.id);
  }
  if (unhashed.length) {
    return { pass: false, evidence: wrong, message: `Email or phone sent unhashed in ${unhashed.length} hit(s).` };
  }
  if (wrong.length) {
    return { pass: false, evidence: wrong, message: `Hashed email or phone values in ${wrong.length} hit(s) do not match the run identity.` };
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
  const leaks = ctx.identity ? scanForeignData(ctx, ctx.identity) : [];
  const evidence = [...real.flatMap((f) => [f.id, ...f.recordIds]), ...leaks.flatMap((l) => l.evidence)];
  const problems = [...real.map((f) => f.detail), ...leaks.map((l) => l.detail)];
  if (!ctx.identity && real.length === 0) {
    add(
      'builtin: possibleRealData',
      false,
      [],
      'Cannot check for data that is not from the run identity: no identity was given and no possibleRealData flags exist.',
    );
    return;
  }
  add(
    'builtin: possibleRealData',
    problems.length === 0,
    evidence,
    problems.length === 0
      ? 'Expected no data that is not from the run identity, found none.'
      : `Expected no data that is not from the run identity, found ${problems.length}: ${problems.join('; ')}.`,
  );
}

function identityOf(run: Run | undefined): Identity | undefined {
  const id = run?.identity;
  if (!id) return undefined;
  const fields = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'zip', 'country'];
  return fields.every((f) => typeof id[f] === 'string') ? (id as unknown as Identity) : undefined;
}

function scanForeignData(ctx: Context, identity: Identity): { detail: string; evidence: string[] }[] {
  const byRequest = new Map<string, { texts: string[]; hitIds: string[]; stepId: string | null }>();
  const slot = (key: string, stepId: string | null) => {
    let entry = byRequest.get(key);
    if (!entry) byRequest.set(key, (entry = { texts: [], hitIds: [], stepId }));
    return entry;
  };
  for (const request of ctx.requests.values()) {
    slot(request.id, request.stepId).texts.push(request.url, request.postData ?? '');
  }
  for (const hit of ctx.hits) {
    const entry = slot(hit.requestId, hit.stepId);
    entry.hitIds.push(hit.id);
    entry.texts.push(...Object.values(hit.params));
  }
  const out: { detail: string; evidence: string[] }[] = [];
  for (const [requestId, entry] of byRequest) {
    const found = new Map<string, string>();
    for (const text of entry.texts) for (const m of scan(text, identity)) found.set(`${m.kind}:${m.value}`, m.kind);
    if (found.size === 0) continue;
    const kinds = [...new Set(found.values())].join(', ');
    const step = entry.stepId ? ` in step ${entry.stepId}` : '';
    out.push({
      detail: `request ${requestId}${step} carries ${found.size} ${kinds} value(s) that are not from the run identity`,
      evidence: [requestId, ...entry.hitIds, ...(entry.stepId ? [entry.stepId] : [])],
    });
  }
  return out;
}
