import {
  fieldHashes,
  findStableHashes,
  hashEmail,
  hashPhone,
  isLibraryLoadPath,
  scan,
  sha256,
  newId,
  type ConsentEpoch,
  type ConsentState,
  type ConsentValue,
  type Checkpoint,
  type Flag,
  type HashForms,
  type Hit,
  type Identity,
  type PingwrightRecord,
  type Run,
  type Request,
  type Response,
  type Result,
  type ResultNote,
  type Severity,
  type Step,
  globToRegExp,
} from '@pingwright/core';
import { GA4_BODY_ONLY_IGNORE, guardFieldName, META_BODY_ONLY_IGNORE, SGTM_BODY_ONLY_IGNORE, isSandboxPageUrl, matchesIgnoreList, identifierClass, identifierSignal, type IdentifierClass } from '@pingwright/decoders';
import { hostMatches } from './hosts.ts';
import { consentFields, countHolds, describeCount, type ConsentField, type Filter, type Rule, type Scenario, type BuiltinName } from './scenario.ts';

export type EvalEpoch = ConsentEpoch;

export interface EvaluateOptions {
  identity?: Identity;
  /** Overrides the scenario option; default 50 ms. */
  graceWindowMs?: number;
}

export const DEFAULT_GRACE_MS = 50;

const MAX_LISTED = 5;
const MAX_NAMES = 12;
const GOOGLE_VENDORS = new Set(['ga4', 'google-ads']);

type Input = PingwrightRecord | EvalEpoch;

interface Context {
  hits: Hit[];
  requests: Map<string, Request>;
  epochs: EvalEpoch[];
  steps: Step[];
  responses: Response[];
  checkpoints: Checkpoint[];
  networkMode?: Run['networkMode'];
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
    responses: records.filter((r): r is Response => r.type === 'response'),
    checkpoints: records.filter((r): r is Checkpoint => r.type === 'checkpoint'),
    networkMode: runRecord?.networkMode,
    grace: options.graceWindowMs ?? scenario.options.graceWindow ?? DEFAULT_GRACE_MS,
    identity: options.identity ?? identityOf(runRecord),
  };

  const results: Result[] = [];
  const add = (expectation: string, pass: boolean, evidence: string[], message: string, severity?: Severity, note?: ResultNote) =>
    results.push({ type: 'result', id: newId('result'), runId, expectation, pass, evidence, message, ...(severity && { severity }), ...(note && { note }) });

  for (const kind of ['mustNot', 'must'] as const)
    for (const rule of scenario.expect[kind]) {
      const { pass, evidence, message, note } = evaluateRule(rule, ctx);
      add(`${kind}: ${rule.description}`, pass, evidence, message, undefined, note);
    }

  builtInChecks(records, scenario, ctx, add);
  return results;
}

type RuleOutcome = { pass: boolean; evidence: string[]; message: string; note?: ResultNote };

function evaluateRule(rule: Rule, ctx: Context): RuleOutcome {
  if (rule.cookie) return evaluateCookieRule(rule, rule.cookie, ctx);
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
  const vacuous = rule.before ? vacuousBeforeConsent(rule, ctx) : undefined;
  if (rule.body) return evaluateBodyRule(rule, rule.body, hits, where, total, vacuous);
  const ids = hits.map((h) => h.id);
  const found = `found ${hits.length} matching hit${hits.length === 1 ? '' : 's'}${narrowed.length ? ` (${total} before narrowing)` : ''}`;

  if (rule.kind === 'mustNot') {
    return {
      pass: hits.length === 0,
      evidence: ids,
      message: (hits.length === 0 ? `Expected no matching hits${where}, found none.` : `Expected no matching hits${where}, ${found}.`) + (vacuous ? ` ${vacuous}` : ''),
    };
  }

  const count = rule.count ?? { op: '>=' as const, n: 1 };
  const pass = countHolds(count, hits.length);
  const message = `Expected ${describeCount(count)} matching hits${where}, ${found}.${vacuous ? ` ${vacuous}` : ''}`;
  if (pass && rule.hashesMatch && hits.length > 0) {
    const check = checkHashes(hits, ctx);
    if (check.pass) return { pass: true, evidence: check.evidence, message: `${message} ${check.message}` };
    const matched = `${hits.length} hit${hits.length === 1 ? '' : 's'} matched ${describeSelector(rule.filter)}${where}`;
    const headline = check.headline ?? (countHolds(count, 0) ? UNMATCHED_HEADLINE : `Expected ${describeCount(count)} hits matching all conditions, found 0.`);
    return { pass: false, evidence: check.evidence, message: `${headline} ${matched}, but identity.hashesMatch failed: ${check.message}` };
  }
  return { pass, evidence: ids, message };
}

const STUB_NO_COOKIES = 'stub mode: stubbed endpoints set no cookies';

interface CookieSighting {
  name: string;
  /** Request ID for a Set-Cookie header, checkpoint ID for a cookie jar. */
  evidence: string;
  /** Absent when the record has no time to place it by. */
  t: number | undefined;
  source: string;
}

function cookieSightings(matchers: RegExp[], ctx: Context): CookieSighting[] {
  const out: CookieSighting[] = [];
  const wanted = (name: string) => matchers.some((m) => m.test(name));
  for (const response of ctx.responses) {
    const t = ctx.requests.get(response.requestId)?.t;
    for (const name of response.setCookieNames) if (wanted(name)) out.push({ name, evidence: response.requestId, t, source: 'Set-Cookie' });
  }
  for (const checkpoint of ctx.checkpoints)
    for (const cookie of checkpoint.cookies) if (wanted(cookie.name)) out.push({ name: cookie.name, evidence: checkpoint.id, t: checkpoint.t, source: `checkpoint "${checkpoint.label}"` });
  return out;
}

function beforeConsentAt(t: number, ctx: Context): boolean {
  const epoch = epochForHit(ctx.epochs, t, ctx.grace);
  return !epoch || (epoch === ctx.epochs[0] && epoch.label === 'undecided');
}

function inEpochAt(t: number, selector: string, ctx: Context): boolean {
  const epoch = epochForHit(ctx.epochs, t, ctx.grace);
  if (selector === 'undecided') return !epoch || epoch.label === 'undecided';
  if (!epoch) return false;
  if (selector.startsWith('label=')) return epoch.label === selector.slice('label='.length);
  if (selector === 'granted' || selector === 'denied') return (epoch.outcome ?? epoch.label) === selector;
  return stateMatches(epoch.state, selector);
}

/**
 * Reads cookie names only. A Set-Cookie header is placed at its request's time. A cookie in a checkpoint is
 * placed at the checkpoint's time, which says it was present then, not when it was set.
 */
function evaluateCookieRule(rule: Rule, patterns: string[], ctx: Context): RuleOutcome {
  let sightings = cookieSightings(patterns.map((p) => globToRegExp(p)), ctx);
  const total = sightings.length;
  const narrowed: string[] = [];
  let from: number | undefined;
  if (rule.after) {
    const step = ctx.steps.find((s) => s.label === rule.after);
    if (!step) {
      const known = ctx.steps.map((s) => s.label).join(', ') || 'none';
      return { pass: false, evidence: [], message: `Expected a step labelled "${rule.after}", but the run has steps: ${known}.` };
    }
    from = step.endedAt ?? step.startedAt;
  }
  const timed = rule.before || rule.inEpoch || from !== undefined;
  const unplaced = timed ? sightings.filter((s) => s.t === undefined) : [];
  if (timed) sightings = sightings.filter((s) => s.t !== undefined);
  const keep = (test: (t: number) => boolean) => {
    sightings = sightings.filter((s) => test(s.t!));
  };
  if (rule.before) {
    keep((t) => beforeConsentAt(t, ctx));
    narrowed.push('before consent');
  }
  if (rule.inEpoch) {
    const selector = rule.inEpoch;
    keep((t) => inEpochAt(t, selector, ctx));
    narrowed.push(`in epoch(${selector})`);
  }
  if (from !== undefined) {
    keep((t) => t >= from);
    narrowed.push(`after ${rule.after}`);
  }

  const where = narrowed.length ? ` ${narrowed.join(', ')}` : '';
  const headerNames = new Set(sightings.filter((s) => s.source === 'Set-Cookie').map((s) => s.name));
  sightings = sightings.filter((s) => s.source === 'Set-Cookie' || !headerNames.has(s.name));
  const evidence = [...new Set(sightings.map((s) => s.evidence))];
  const wantedCount = rule.kind === 'must' ? { op: '>=' as const, n: 1 } : { op: '=' as const, n: 0 };
  const low = countHolds(wantedCount, sightings.length);
  if (low !== countHolds(wantedCount, sightings.length + unplaced.length)) {
    return {
      pass: false,
      evidence: unplaced.map((s) => s.evidence),
      message: `cannot evaluate: ${unplaced.length} matching cookie${unplaced.length === 1 ? '' : 's'} in a checkpoint with no time${where}.`,
    };
  }
  const names = [...new Set(sightings.map((s) => guardFieldName(s.name)))].sort();
  const sources = [...new Set(sightings.map((s) => s.source))];
  const found = sightings.length
    ? `found ${listNames(names)} from ${sources.join(' and ')} (${total} before narrowing)${sources.some((s) => s !== 'Set-Cookie') ? '. A checkpoint shows the cookie was present then, not when it was set' : ''}`
    : `found no matching cookie (${total} before narrowing)`;
  const expected = rule.kind === 'must' ? `Expected a matching cookie${where}` : `Expected no matching cookie${where}`;
  const stubbed = low && rule.kind === 'mustNot' && ctx.networkMode === 'stub';
  return {
    pass: low,
    evidence,
    message: `${expected}, ${found}.${stubbed ? ` ${STUB_NO_COOKIES}` : ''}`,
    ...(stubbed && { note: 'stubNoCookies' as const }),
  };
}

const NOT_RECORDED = 'cannot evaluate: field names not recorded';
const BODY_CUT = 'cannot evaluate: body not fully recorded';
const VENDOR_IGNORE: Record<string, readonly string[]> = { ga4: GA4_BODY_ONLY_IGNORE, meta: META_BODY_ONLY_IGNORE, sgtm: SGTM_BODY_ONLY_IGNORE };

function listNames(names: string[]): string {
  return names.length > MAX_NAMES ? `${names.slice(0, MAX_NAMES).join(', ')} and ${names.length - MAX_NAMES} more` : names.join(', ');
}

function cannotEvaluate(unreadable: Hit[], where: string): RuleOutcome {
  const notRecorded = unreadable.some((h) => !h.fields);
  return {
    pass: false,
    evidence: unreadable.map((h) => h.id),
    message: `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} selected hit${unreadable.length === 1 ? '' : 's'}${where}.`,
    note: notRecorded ? 'fieldsNotRecorded' : 'cannotEvaluateBody',
  };
}

function evaluateBodyRule(rule: Rule, body: NonNullable<Rule['body']>, selected: Hit[], where: string, total: number, vacuous?: string): RuleOutcome {
  const tail = vacuous ? ` ${vacuous}` : '';
  const narrowed = `${selected.length} selected hit${selected.length === 1 ? '' : 's'}${where}`;
  if (body.has) {
    const matchers = body.has.map((name) => globToRegExp(name));
    const unreadable: Hit[] = [];
    const matching: { hit: Hit; names: string[] }[] = [];
    for (const hit of selected) {
      if (!hit.fields) {
        unreadable.push(hit);
        continue;
      }
      const names = hit.fields.filter((f) => matchers.some((m) => m.test(f)));
      if (names.length) matching.push({ hit, names });
      else if (hit.fieldsComplete === false) unreadable.push(hit);
    }
    const count = rule.kind === 'must' ? (rule.count ?? { op: '>=' as const, n: 1 }) : { op: '=' as const, n: 0 };
    const low = countHolds(count, matching.length);
    const high = countHolds(count, matching.length + unreadable.length);
    if (low !== high) return cannotEvaluate(unreadable, where);
    const names = [...new Set(matching.flatMap((m) => m.names))].sort();
    const evidence = matching.map((m) => m.hit.id);
    const found = matching.length
      ? `found ${matching.length} hit${matching.length === 1 ? '' : 's'} with body.has fields: ${listNames(names)}`
      : 'found no hit with the body.has fields';
    const expected = rule.kind === 'must' ? `Expected ${describeCount(count)} hits with body.has fields${where}` : `Expected no hit with body.has fields${where}`;
    return { pass: low, evidence, message: `${expected}, ${found} (${total} before narrowing).${tail}` };
  }

  const only = body.only!;
  const allowed = [...only, ...(body.ignore ?? [])].map((name) => globToRegExp(name));
  if (rule.kind === 'must') {
    const count = rule.count ?? { op: '>=' as const, n: 1 };
    if (!countHolds(count, selected.length))
      return { pass: false, evidence: selected.map((h) => h.id), message: `Expected ${describeCount(count)} matching hits${where}, found ${selected.length}.${tail}` };
  }
  const unreadable: Hit[] = [];
  const offenders: { hit: Hit; outside: string[] }[] = [];
  for (const hit of selected) {
    if (!hit.fields) {
      unreadable.push(hit);
      continue;
    }
    const vendorIgnore = VENDOR_IGNORE[hit.vendor] ?? [];
    const outside = hit.fields.filter((f) => !allowed.some((m) => m.test(f)) && !matchesIgnoreList(f, vendorIgnore));
    if (outside.length) offenders.push({ hit, outside });
    else if (hit.fieldsComplete === false) unreadable.push(hit);
  }
  if (offenders.length) {
    const lines = offenders.slice(0, MAX_LISTED).map((o) => `${o.hit.id} has fields outside body.only: ${listNames(o.outside)} (${o.outside.length} of ${o.hit.fields!.length})`);
    const more = offenders.length > MAX_LISTED ? ` and ${offenders.length - MAX_LISTED} more hits` : '';
    return { pass: false, evidence: offenders.map((o) => o.hit.id), message: `${lines.join('; ')}${more}.${tail}` };
  }
  if (unreadable.length) return cannotEvaluate(unreadable, where);
  return { pass: true, evidence: selected.map((h) => h.id), message: `All ${narrowed} have only fields allowed by body.only.${tail}` };
}

function describeSelector(filter: Filter): string {
  const parts = [
    filter.vendor && 'vendor',
    filter.event && 'event',
    filter.host && 'host',
    filter.transport && 'transport',
    filter.page && 'page',
    filter.outcome && 'outcome',
    Object.keys(filter.ids).length > 0 && 'ids',
    Object.keys(filter.params).length > 0 && 'params',
    Object.keys(filter.consent).length > 0 && 'consent',
  ].filter((p): p is string => !!p);
  if (parts.length === 0) return 'the selector';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/**
 * Before consent, a non-Google hit takes the undecided epoch's state, so a granted or denied filter
 * cannot match it when that state does not say so.
 */
function vacuousBeforeConsent(rule: Rule, ctx: Context): string | undefined {
  const vendors = rule.filter.vendor;
  if (!vendors || vendors.some((v) => GOOGLE_VENDORS.has(v))) return undefined;
  const first = ctx.epochs[0];
  const state = first?.label === 'undecided' ? first.state : undefined;
  const blocked = consentFields.filter((f) => {
    const want = rule.filter.consent[f];
    return want !== undefined && (state?.[f] ?? 'unknown') !== want;
  });
  if (!blocked.length) return undefined;
  return `This rule cannot match: before consent, ${vendors.join(', ')} hits take the undecided state, where ${blocked.join(', ')} is not ${rule.filter.consent[blocked[0]!]}.`;
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
    const have = idValue(hit, name);
    const compared = name.endsWith('.matchesIdentity');
    const present = compared ? have === true : have !== undefined && have !== false;
    const absent = compared ? have === false : !present;
    if (want === 'present') {
      if (!present) return false;
    } else if (want === 'absent') {
      if (!absent) return false;
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
    if (f.host && !hostForms(request.url).some((form) => f.host!.includes(form))) return false;
    if (f.outcome && !f.outcome.includes(request.outcome)) return false;
  }
  return true;
}

/** Reads `ids.<name>`, `ids.hashes` (any hash present), or `ids.hashes.<param>` and `ids.hashes.<param>.matchesIdentity` from the nested hashes. */
function idValue(hit: Hit, name: string): boolean | null | undefined {
  if (name === 'hashes') return Object.values(hit.ids.hashes ?? {}).some((h) => h.present);
  if (Object.hasOwn(hit.ids, name)) {
    const flat = hit.ids[name];
    if (typeof flat !== 'object') return flat;
  }
  const [head, field, prop, ...rest] = name.split('.');
  if (head !== 'hashes' || !field || rest.length) return undefined;
  const hash = hit.ids.hashes && Object.hasOwn(hit.ids.hashes, field) ? hit.ids.hashes[field] : undefined;
  if (!hash) return undefined;
  if (prop === undefined) return hash.present;
  return prop === 'matchesIdentity' ? hash.matchesIdentity : undefined;
}

/** A `host:` rule matches the host with its port (`127.0.0.1:4173`) or the bare hostname (`127.0.0.1`). An IPv6 host may be written with or without brackets (`::1`, `[::1]`). */
function hostForms(url: string): string[] {
  try {
    const { host, hostname } = new URL(url);
    return [host, hostname, hostname.replace(/^\[|\]$/g, '')];
  } catch {
    return [''];
  }
}

type Placeable = Pick<ConsentEpoch, 'startT'> & Partial<Pick<ConsentEpoch, 'state' | 'label'>>;

function revokes(prev: Placeable, next: Placeable): boolean {
  if (next.label === 'withdrawn') return true;
  const before = prev.state;
  const after = next.state;
  return !!before && !!after && consentFields.some((f) => before[f] === 'granted' && after[f] === 'denied');
}

/**
 * The epoch a hit belongs to. A hit within the grace window before a boundary belongs to the new
 * epoch, since tags may fire on the consent update itself. That does not hold when the new epoch
 * denies a signal the previous one granted (a withdrawal, or a reject after a granted default): a hit
 * before it was sent while consent was still granted. A hit before the first epoch belongs to
 * none, unless that epoch is undecided, which is what the visitor was before it.
 */
export function epochForHit<E extends Placeable>(epochs: readonly E[], t: number, graceMs = DEFAULT_GRACE_MS): E | undefined {
  let found: E | undefined;
  epochs.forEach((e, i) => {
    const start = i === 0 ? (e.label === 'undecided' ? -Infinity : e.startT) : revokes(epochs[i - 1]!, e) ? e.startT : e.startT - graceMs;
    if (t >= start) found = e;
  });
  return found;
}

function epochOf(hit: Hit, ctx: Context): EvalEpoch | undefined {
  return epochForHit(ctx.epochs, hit.t, ctx.grace);
}

/**
 * A Google hit that carries any consent states its own consent, and a field it does not carry stays
 * unknown. Every other hit takes the state of the epoch it falls in.
 */
function effectiveConsent(hit: Hit, ctx: Context): ConsentState {
  return effectiveConsentAt(hit, ctx.epochs, ctx.grace);
}

/** The consent state the evaluator uses for a hit. `epochs` must be sorted by `startT`. */
export function effectiveConsentAt(hit: Hit, epochs: readonly EvalEpoch[], graceMs: number): ConsentState {
  const base = epochForHit(epochs, hit.t, graceMs)?.state;
  const own = GOOGLE_VENDORS.has(hit.vendor) && consentFields.some((f) => hit.consent[f] !== 'unknown');
  const pick = (f: ConsentField): ConsentValue => {
    if (own) return hit.consent[f];
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
  return !epoch || epoch.label === 'undecided';
}

function isBeforeConsent(hit: Hit, ctx: Context): boolean {
  const epoch = epochOf(hit, ctx);
  return !epoch || (epoch === ctx.epochs[0] && epoch.label === 'undecided');
}

function inEpoch(hit: Hit, selector: string, ctx: Context): boolean {
  if (selector === 'undecided') return inUndecidedEpoch(hit, ctx);
  if (selector.startsWith('label=')) return epochOf(hit, ctx)?.label === selector.slice('label='.length);
  if ((selector === 'granted' || selector === 'denied') && !GOOGLE_VENDORS.has(hit.vendor)) {
    const epoch = epochOf(hit, ctx);
    return (epoch?.outcome ?? epoch?.label) === selector;
  }
  return stateMatches(effectiveConsent(hit, ctx), selector);
}

const UNMATCHED_HEADLINE = 'Expected every hashed identity value to match the run identity.';
const EMAIL_PARAM = /^(?:em|ud\[em\]|hashedEmail|sha256_email_address|user_data\.email_address)$/;
const PHONE_PARAM = /^(?:ph|ud\[ph\]|hashedPhone|sha256_phone_number|user_data\.phone_number)$/;
const FIELD_PARAMS: Record<string, (identity: Identity) => string> = {
  'user_data.first_name': (i) => i.firstName,
  'user_data.last_name': (i) => i.lastName,
  'user_data.street': (i) => i.address1,
  'user_data.city': (i) => i.city,
  'user_data.postal_code': (i) => i.zip,
  'user_data.country': (i) => i.country,
};

const FIELD_LABELS: Record<string, string> = {
  'user_data.first_name': 'first name',
  'user_data.last_name': 'last name',
  'user_data.street': 'street',
  'user_data.city': 'city',
  'user_data.postal_code': 'postal code',
  'user_data.country': 'country',
};

function fieldLabel(name: string): string {
  return EMAIL_PARAM.test(name) ? 'email' : PHONE_PARAM.test(name) ? 'phone' : (FIELD_LABELS[name] ?? name);
}

function joinLabels(labels: Set<string>): string {
  const all = [...labels];
  return all.length > 1 ? `${all.slice(0, -1).join(', ')} and ${all.at(-1)}` : (all[0] ?? '');
}

const PLAIN_ADDRESS_PARAMS = new Set(['user_data.city', 'user_data.postal_code', 'user_data.country']);
const DIGEST_SHAPE = /^(?:[0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?)$/i;

function allForms(h: HashForms): string[] {
  return [h.hex, h.base64, h.base64url];
}

function checkHashes(hits: Hit[], ctx: Context): { pass: boolean; evidence: string[]; message: string; headline?: string } {
  const identity = ctx.identity;
  if (!identity) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      headline: 'Expected every hashed identity value to match the run identity, but it could not be checked.',
      message: 'no run identity was given, so the hashes could not be checked.',
    };
  }
  const emailHashes = new Set(allForms(hashEmail(identity.email)));
  const phone = hashPhone(identity.phone);
  const phoneHashes = new Set([...allForms(phone), ...allForms(sha256(identity.phone.replace(/\D/g, '')))]);
  const plain = new Set([identity.email.toLowerCase(), identity.phone.toLowerCase(), identity.phone.replace(/\D/g, '')]);
  // A literal fill value stands in for a field the checkout would not take as generated, such as a German city,
  // so it can match a name or address hash. An email or phone must still be the identity's own.
  const extra = identity.extra ?? [];
  const withHash: string[] = [];
  const wrong: string[] = [];
  const unhashed: string[] = [];
  const wrongFields = new Set<string>();
  const wrongParams = new Set<string>();
  const matchedFields = new Set<string>();
  const unhashedFields = new Set<string>();
  for (const hit of hits) {
    let seen = false;
    let bad = false;
    let raw = false;
    for (const [name, value] of Object.entries(hit.params)) {
      const field = FIELD_PARAMS[name]?.(identity);
      const accepted = field === undefined ? [] : [field, ...extra];
      const known = EMAIL_PARAM.test(name)
        ? emailHashes
        : PHONE_PARAM.test(name)
          ? phoneHashes
          : field !== undefined
            ? fieldHashes(...accepted)
            : undefined;
      if (!known || !value) continue;
      // Google's user data format sends city, postal code and country as plain text.
      if (PLAIN_ADDRESS_PARAMS.has(name) && !DIGEST_SHAPE.test(value)) continue;
      seen = true;
      if (known.has(value)) {
        matchedFields.add(fieldLabel(name));
        continue;
      }
      bad = true;
      const typed = value.trim().toLowerCase();
      if (plain.has(typed) || accepted.some((v) => v.trim().toLowerCase() === typed)) {
        raw = true;
        unhashedFields.add(fieldLabel(name));
      } else {
        wrongFields.add(fieldLabel(name));
        wrongParams.add(name);
      }
    }
    if (seen) withHash.push(hit.id);
    if (bad) wrong.push(hit.id);
    if (raw) unhashed.push(hit.id);
  }
  const several = hits.length > 1;
  const they = several ? 'they' : 'it';
  const of = (n: number) => (several ? ` (${n} of ${hits.length} hits)` : '');
  if (unhashed.length) {
    return { pass: false, evidence: unhashed, headline: UNMATCHED_HEADLINE, message: `${they} carried an unhashed ${joinLabels(unhashedFields)}${of(unhashed.length)}.` };
  }
  if (wrong.length) {
    const matching = new Set([...matchedFields].filter((f) => !wrongFields.has(f)));
    const message =
      `the hashed ${joinLabels(wrongFields)} values ${they} carried do not match the run identity${of(wrong.length)}. ` +
      `Not matching: ${[...wrongParams].join(', ')}.` +
      (matching.size ? ` Matching: ${joinLabels(matching)}.` : '');
    return { pass: false, evidence: wrong, headline: UNMATCHED_HEADLINE, message };
  }
  if (!withHash.length) {
    return { pass: false, evidence: hits.map((h) => h.id), message: `${several ? 'none of them carried any' : 'it carried no'} hashed email, phone, name or address value.` };
  }
  return { pass: true, evidence: withHash, message: `Hashed values in ${withHash.length} hit(s) match the run identity.` };
}

function flagHost(flag: Flag, ctx: Context): string {
  const urls = [ctx.requests.get(flag.recordIds[0] ?? '')?.url, /\s(\S+)$/.exec(flag.detail)?.[1]];
  for (const url of urls) {
    try {
      if (url) return new URL(url).hostname;
    } catch {
      continue;
    }
  }
  return '';
}

function countByHost(flags: readonly Flag[], ctx: Context): string {
  const counts = new Map<string, number>();
  for (const f of flags) {
    const host = flagHost(f, ctx) || '(unknown host)';
    counts.set(host, (counts.get(host) ?? 0) + 1);
  }
  return [...counts].map(([host, n]) => `${host} x${n}`).join(', ');
}

function builtInChecks(
  records: readonly Input[],
  scenario: Scenario,
  ctx: Context,
  addResult: (expectation: string, pass: boolean, evidence: string[], message: string, severity?: Severity, note?: ResultNote) => void,
) {
  const add = (name: BuiltinName, pass: boolean, evidence: string[], message: string, note?: ResultNote) =>
    addResult(`builtin: ${name}`, pass, evidence, message, scenario.options.builtins?.[name] ?? 'fail', note);
  const flags = records.filter((r) => r.type === 'flag');

  const unknown = flags.filter((f) => f.kind === 'unknownDestination');
  const allow = scenario.options.allowUnknownDestination;
  const allowedHosts = Array.isArray(allow) ? allow : [];
  const isAllowed = (f: (typeof unknown)[number]) => allow === true || hostMatches(flagHost(f, ctx), allowedHosts);
  const blocked = unknown.filter((f) => !isAllowed(f));
  const allowedCount = unknown.length - blocked.length;
  add(
    'unknownDestination',
    blocked.length === 0,
    blocked.length === 0 ? unknown.map((f) => f.id) : blocked.flatMap((f) => [f.id, ...f.recordIds]),
    blocked.length > 0
      ? `Expected no requests to unknown destinations, found ${blocked.length}: ${countByHost(blocked, ctx)}.`
      : unknown.length > 0
        ? `Unknown destinations allowed by the scenario; ${allowedCount} flagged.`
        : 'Expected no requests to unknown destinations, found none.',
  );

  const sandboxed = ctx.hits.filter((h) => isSandboxPageUrl(h.page));
  add(
    'sandboxPageUrl',
    sandboxed.length === 0,
    sandboxed.map((h) => h.id),
    sandboxed.length === 0
      ? 'Expected no hit to carry a sandbox URL as its page, found none.'
      : `Expected no hit to carry a sandbox URL as its page, found ${sandboxed.length}: ${sandboxed[0]!.page}.`,
  );

  deniedIdentifiersCheck(scenario, ctx, add);

  const real = flags.filter((f) => f.kind === 'possibleRealData');
  // Flags from the recorder come from the raw records. Scanning again only adds requests the recorder did not flag.
  const flagged = new Set(real.flatMap((f) => f.recordIds));
  const leaks = ctx.identity ? findForeignData(ctx.requests.values(), ctx.hits, ctx.identity).filter((l) => !flagged.has(l.requestId)) : [];
  const evidence = [...real.flatMap((f) => [f.id, ...f.recordIds]), ...leaks.flatMap((l) => l.evidence)];
  const problems = [...real.map((f) => f.detail), ...leaks.map((l) => l.detail)];
  const shown = problems.slice(0, MAX_LISTED).join('; ');
  const more = problems.length > MAX_LISTED ? `; and ${problems.length - MAX_LISTED} more` : '';
  if (!ctx.identity && real.length === 0) {
    add(
      'possibleRealData',
      false,
      [],
      'Cannot check for data that is not from the run identity: no identity was given and no possibleRealData flags exist.',
    );
    return;
  }
  add(
    'possibleRealData',
    problems.length === 0,
    evidence,
    problems.length === 0
      ? 'Expected no data that is not from the run identity, found none.'
      : `Expected no data that is not from the run identity, found ${problems.length}: ${shown}${more}.`,
  );
}

const DENIABLE = ['analytics', 'ads', 'adUserData'] as const;

function deniedIdentifiersCheck(
  scenario: Scenario,
  ctx: Context,
  add: (name: BuiltinName, pass: boolean, evidence: string[], message: string, note?: ResultNote) => void,
) {
  const extra = (scenario.options.identifierFields ?? []).map(globToRegExp);
  const leaking: Hit[] = [];
  const unreadable: Hit[] = [];
  const found = new Map<string, Set<string>>();
  for (const hit of ctx.hits) {
    const state = effectiveConsent(hit, ctx);
    if (!DENIABLE.some((f) => state[f] === 'denied')) continue;
    if (!hit.idFields || !hit.fields) {
      unreadable.push(hit);
      continue;
    }
    const classes = new Map<string, IdentifierClass>(hit.idFields.map((n) => [n, identifierClass(n)]));
    for (const n of hit.fields) if (!classes.has(n) && extra.some((re) => re.test(n))) classes.set(n, 'analytics');
    let flagged = false;
    for (const [name, cls] of classes) {
      const signal = identifierSignal(cls, state);
      if (signal.value !== 'denied') continue;
      flagged = true;
      const key = `${hit.vendor}\0${signal.field}`;
      found.set(key, (found.get(key) ?? new Set()).add(name));
    }
    if (flagged) leaking.push(hit);
    else if (hit.fieldsComplete === false) unreadable.push(hit);
  }
  if (leaking.length > 0) {
    const groups = [...found].map(([key, names]) => {
      const [vendor, signal] = key.split('\0');
      return `${vendor} ${listNames([...names].sort())} (${signal} denied)`;
    });
    const shown = groups.slice(0, MAX_LISTED).join(', ');
    const more = groups.length > MAX_LISTED ? `, and ${groups.length - MAX_LISTED} more` : '';
    const cut = unreadable.length > 0 ? ` ${unreadable.length} more hit${unreadable.length === 1 ? '' : 's'} could not be read.` : '';
    add(
      'deniedIdentifiers',
      false,
      leaking.map((h) => h.id),
      `${leaking.length} hit${leaking.length === 1 ? ' carries' : 's carry'} identifiers while consent is denied: ${shown}${more}.${cut}`,
    );
  } else if (unreadable.length > 0) {
    const notRecorded = unreadable.some((h) => !h.idFields || !h.fields);
    add(
      'deniedIdentifiers',
      false,
      unreadable.map((h) => h.id),
      `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} hit${unreadable.length === 1 ? '' : 's'} sent while consent is denied.`,
      notRecorded ? 'fieldsNotRecorded' : 'cannotEvaluateBody',
    );
  } else {
    add('deniedIdentifiers', true, [], 'Expected no identifiers on hits sent while consent is denied, found none.');
  }
}

function identityOf(run: Run | undefined): Identity | undefined {
  const id = run?.identity;
  if (!id) return undefined;
  const fields = ['firstName', 'lastName', 'email', 'phone', 'address1', 'city', 'zip', 'country'];
  const values = id as unknown as Record<string, unknown>;
  return fields.every((f) => typeof values[f] === 'string') ? id : undefined;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

// Content-addressed assets are named /<sha256>.<ext>. That name cannot be told apart from a hashed id used as a
// pixel file name (design §13), so only that exact segment shape is skipped; the rest of the path is still scanned.
const ASSET_TYPES = new Set(['image', 'script', 'stylesheet', 'font', 'media']);
const HASH_FILE_SEGMENT = /\/[0-9a-f]{64}\.[a-z0-9]{1,5}(?=$|\/)/gi;

// A digest inside a file name, after a name and a "-", "_" or ".", is a content hash: the same for every visitor
// (app-<hex>.js). A segment that is only a digest, or "key=<hex>.ext", is not matched and is still scanned. Image
// requests skip .gif too: that is the tracking-pixel name.
const NAMED_HASH_IN_SEGMENT = /(?<=\/[^/=;]+[-_.])[0-9a-f]{64}(?=\.[a-z0-9]{1,8}(?:$|\/))/gi;
const NAMED_HASH_NOT_GIF = /(?<=\/[^/=;]+[-_.])[0-9a-f]{64}(?=\.(?!gif(?:$|\/))[a-z0-9]{1,8}(?:$|\/))/gi;
const NAMED_HASH_TYPES = new Set(['script', 'stylesheet', 'font', 'media', 'fetch', 'xhr']);
const HEX64 = /^[0-9a-f]{64}$/i;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Blanks only the top-level id and sha256Hash and extensions.persistedQuery.sha256Hash. variables is never touched.
function blankOperation(op: unknown): void {
  if (!isObject(op)) return;
  for (const key of Object.keys(op)) {
    if (/^(?:id|sha256hash)$/i.test(key) && typeof op[key] === 'string' && HEX64.test(op[key] as string)) op[key] = '';
  }
  const extensions = typeof op.extensions === 'string' ? parseJson(op.extensions) : op.extensions;
  if (isObject(extensions) && isObject(extensions.persistedQuery)) {
    const pq = extensions.persistedQuery;
    if (typeof pq.sha256Hash === 'string' && HEX64.test(pq.sha256Hash)) pq.sha256Hash = '';
    if (typeof op.extensions === 'string') op.extensions = JSON.stringify(extensions);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function blankedJson(text: string): string {
  const parsed = parseJson(text);
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return text;
  for (const op of Array.isArray(parsed) ? parsed : [parsed]) blankOperation(op);
  return JSON.stringify(parsed);
}

function blankedExtensions(text: string): string {
  const parsed = parseJson(text);
  if (parsed === undefined) return text;
  const wrapper = { extensions: parsed };
  blankOperation(wrapper);
  return JSON.stringify(wrapper.extensions);
}

function blankedParams(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  const blanked = new Set<string>();
  for (const [key, value] of params) {
    const name = key.toLowerCase();
    if ((name === 'id' || name === 'sha256hash') && HEX64.test(value) && !blanked.has(name)) {
      blanked.add(name);
      out.append(key, '');
    } else if (key === 'extensions') out.append(key, blankedExtensions(value));
    else out.append(key, value);
  }
  return out;
}

// Only the top-level id, sha256Hash and extensions.persistedQuery.sha256Hash of a GraphQL persisted-query request
// are dropped. Those name a stored query, the same for every visitor. variables and every other key are scanned.
function withoutPersistedQueryIds(url: string, postData: string): { url: string; postData: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { url, postData };
  }
  if (!/\/graphql/i.test(parsed.pathname)) return { url, postData };
  if (!/persisted/i.test(parsed.pathname) && !/persistedQuery/.test(parsed.search + postData)) return { url, postData };
  parsed.search = blankedParams(parsed.searchParams).toString();
  let body = postData;
  if (/^\s*[[{]/.test(postData)) body = blankedJson(postData);
  else if (postData.includes('=')) body = blankedParams(new URLSearchParams(postData)).toString();
  return { url: parsed.href, postData: body };
}

function scannedUrl(request: Request, url: string, isHit: boolean): string {
  try {
    const parsed = new URL(url);
    if (!isHit) {
      if (NAMED_HASH_TYPES.has(request.resourceType)) parsed.pathname = parsed.pathname.replace(NAMED_HASH_IN_SEGMENT, '');
      else if (request.resourceType === 'image') parsed.pathname = parsed.pathname.replace(NAMED_HASH_NOT_GIF, '');
    }
    if (ASSET_TYPES.has(request.resourceType)) parsed.pathname = parsed.pathname.replace(HASH_FILE_SEGMENT, '/');
    return parsed.href;
  } catch {
    return url;
  }
}

// Each path segment is also scanned as a value of its own, so a "+" that starts a segment can start a phone.
function pathSegments(url: string): string[] {
  try {
    return new URL(url).pathname.split('/').filter(Boolean);
  } catch {
    return [];
  }
}

export interface ForeignData {
  requestId: string;
  detail: string;
  /** The request, its hits and its step. */
  evidence: string[];
}

/** Finds email, phone and hash values in requests and hits that are not the identity's own. Takes raw records. */
export function findForeignData(requests: Iterable<Request>, hits: readonly Hit[], identity: Identity): ForeignData[] {
  const byRequest = new Map<string, { texts: string[]; hitIds: string[]; stepId: string | null }>();
  const slot = (key: string, stepId: string | null) => {
    let entry = byRequest.get(key);
    if (!entry) byRequest.set(key, (entry = { texts: [], hitIds: [], stepId }));
    return entry;
  };
  const hitRequests = new Set(hits.map((h) => h.requestId));
  for (const request of requests) {
    if (request.resourceType === 'script' && isLibraryLoadPath(pathOf(request.url))) continue;
    const persisted = withoutPersistedQueryIds(request.url, request.postData ?? '');
    const url = scannedUrl(request, persisted.url, hitRequests.has(request.id));
    slot(request.id, request.stepId).texts.push(url, ...pathSegments(url), persisted.postData);
  }
  for (const hit of hits) {
    const entry = slot(hit.requestId, hit.stepId);
    entry.hitIds.push(hit.id);
    for (const [key, value] of Object.entries(hit.params)) entry.texts.push(`${key}=${value}`);
  }
  const stableHashes = findStableHashes(
    [...byRequest].flatMap(([requestId, entry]) => entry.texts.map((text) => ({ requestId, text }))),
  );
  const out: ForeignData[] = [];
  for (const [requestId, entry] of byRequest) {
    const found = new Map<string, string>();
    for (const text of entry.texts) for (const m of scan(text, identity, { stableHashes })) found.set(`${m.kind}:${m.value}`, m.kind);
    if (found.size === 0) continue;
    const kinds = [...new Set(found.values())].join(', ');
    const step = entry.stepId ? ` in step ${entry.stepId}` : '';
    out.push({
      requestId,
      detail: `request ${requestId}${step} carries ${found.size} ${kinds} value(s) that are not from the run identity`,
      evidence: [requestId, ...entry.hitIds, ...(entry.stepId ? [entry.stepId] : [])],
    });
  }
  return out;
}

/** Places each non-Google hit in the epoch `evaluate` would judge it by. Google hits carry their own consent. */
export function placeHitsInEpochs(
  hits: readonly Hit[],
  epochs: readonly ConsentEpoch[],
  graceMs = DEFAULT_GRACE_MS,
): Map<Hit, ConsentEpoch | undefined> {
  const sorted = [...epochs].sort((a, b) => a.startT - b.startT);
  return new Map(hits.filter((h) => !GOOGLE_VENDORS.has(h.vendor)).map((h) => [h, epochForHit(sorted, h.t, graceMs)]));
}
