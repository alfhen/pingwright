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
  type TagreeveRecord,
  type Run,
  type Request,
  type Response,
  type Result,
  type ResultNote,
  type Severity,
  type Step,
  binaryShare,
  globToRegExp,
} from '@tagreeve/core';
import { GA4_BODY_ONLY_IGNORE, type MultipartBody, bodyEntries, guardFieldName, multipartPartName, splitMultipart, META_BODY_ONLY_IGNORE, META_CAPI_BODY_ONLY_IGNORE, META_CAPI_PARAM_NAMES, metaCapiBaseParam, SGTM_BODY_ONLY_IGNORE, isSandboxPageUrl, matchesIgnoreList, identifierClass, identifierSignal, type IdentifierClass } from '@tagreeve/decoders';
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

type Input = TagreeveRecord | EvalEpoch;

interface Context {
  hits: Hit[];
  requests: Map<string, Request>;
  index: JudgeIndex;
  epochs: EvalEpoch[];
  steps: Step[];
  responses: Response[];
  checkpoints: Checkpoint[];
  networkMode?: Run['networkMode'];
  grace: number;
  identity?: Identity;
  /** Hits that count as inside every epoch, time and consent selector of a rule. */
  anywhere?: ReadonlySet<string>;
}

export function evaluate(records: readonly Input[], scenario: Scenario, options: EvaluateOptions = {}): Result[] {
  const runRecord = records.find((r): r is Run => r.type === 'run');
  const runId = runRecord?.id ?? records.find((r) => 'runId' in r)?.runId ?? newId('run');
  const allHits = records.filter((r): r is Hit => r.type === 'hit');
  const allRequests = new Map(records.filter((r): r is Request => r.type === 'request').map((r) => [r.id, r]));
  const ctx: Context = {
    hits: allHits,
    requests: allRequests,
    index: judgeIndex(allHits, allRequests),
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
  const add = (expectation: string, pass: boolean, evidence: string[], message: string, severity?: Severity, note?: ResultNote, timeJudged = false) => {
    const settled = settleServerSends(pass, evidence, severity, note, timeJudged, ctx);
    results.push({
      type: 'result',
      id: newId('result'),
      runId,
      expectation,
      pass,
      evidence,
      message,
      ...(settled.severity && { severity: settled.severity }),
      ...(settled.note && { note: settled.note }),
    });
  };

  for (const kind of ['mustNot', 'must'] as const)
    for (const rule of scenario.expect[kind]) {
      const outcome = evaluateRule(rule, ctx);
      const { pass, evidence, message } = outcome;
      const passes = (c: Context) => evaluateRuleHits(rule, c).pass;
      const scoped = isScoped(rule);
      const note = outcome.note ?? (pass && scoped && passRestsOnProbableLink(ctx, passes) ? 'serverSendProbableLink' : undefined);
      add(`${kind}: ${rule.description}`, pass, evidence, message, undefined, note, scoped && (pass || failureRestsOnProbableLink(ctx, passes)));
    }

  builtInChecks(records, scenario, ctx, add);
  return results;
}

type RuleOutcome = { pass: boolean; evidence: string[]; message: string; note?: ResultNote };

const isScoped = (rule: Rule) => Boolean(rule.before || rule.inEpoch || rule.after || consentFields.some((f) => rule.filter.consent[f]));

function evaluateRule(rule: Rule, ctx: Context): RuleOutcome {
  const outcome = evaluateRuleHits(rule, ctx);
  if (rule.cookie || !isScoped(rule)) return outcome;
  const unjudged = ctx.hits.filter((h) => isUnlinkedServerHit(h, ctx.index) && matchesFilter(h, { ...rule.filter, consent: {} }, ctx));
  if (unjudged.length === 0) return outcome;
  if (rule.kind === 'mustNot') {
    if (!outcome.pass) return outcome;
  } else if (evaluateRuleHits(rule, { ...ctx, anywhere: new Set(unjudged.map((h) => h.id)) }).pass === outcome.pass) {
    // In the most favourable place the unlinked hits change nothing, so they do not matter.
    return outcome;
  }
  return {
    pass: false,
    evidence: [...outcome.evidence, ...unjudged.map((h) => h.id)],
    message: `${outcome.message} Cannot evaluate: ${unjudged.length} server container hit${unjudged.length === 1 ? ' has' : 's have'} no link to a browser hit, so no consent state or time applies to ${unjudged.length === 1 ? 'it' : 'them'}.`,
    note: 'serverSendUnlinked',
  };
}

/** The context with the given server hits placed by their own time, as if the browser had sent them. */
function asBrowserHits(ctx: Context, hits: readonly Hit[]): Context {
  const requests = new Map(ctx.requests);
  for (const h of hits) {
    const request = requests.get(h.requestId);
    if (!request) continue;
    const own = { ...request };
    delete own.captured;
    requests.set(h.requestId, own);
  }
  return { ...ctx, requests, index: judgeIndex(ctx.hits, requests) };
}

/** True when the verdict `passes` gives would change if the probable-linked server hits were placed by their own time. */
function passRestsOnProbableLink(ctx: Context, passes: (ctx: Context) => boolean): boolean {
  const probable = ctx.hits.filter((h) => h.via?.confidence === 'probable' && viaHitOf(h, ctx.index) !== undefined);
  return probable.length > 0 && !passes(asBrowserHits(ctx, probable));
}

/** True when the failing verdict `passes` gives would change if the probable-linked server hits were placed by their own time or left out. */
function failureRestsOnProbableLink(ctx: Context, passes: (ctx: Context) => boolean): boolean {
  const probable = ctx.hits.filter((h) => h.via?.confidence === 'probable' && viaHitOf(h, ctx.index) !== undefined);
  if (probable.length === 0) return false;
  const ids = new Set(probable.map((h) => h.id));
  return passes(asBrowserHits(ctx, probable)) || passes({ ...ctx, hits: ctx.hits.filter((h) => !ids.has(h.id)) });
}

function evaluateRuleHits(rule: Rule, ctx: Context): RuleOutcome {
  if (rule.cookie) return evaluateCookieRule(rule, rule.cookie, ctx);
  const anywhere = (h: Hit) => ctx.anywhere?.has(h.id) ?? false;
  let hits = ctx.hits.filter((h) => matchesFilter(h, anywhere(h) ? { ...rule.filter, consent: {} } : rule.filter, ctx));
  const total = hits.length;
  const narrowed: string[] = [];

  if (rule.before) {
    hits = hits.filter((h) => anywhere(h) || isBeforeConsent(h, ctx));
    narrowed.push('before consent');
  }
  if (rule.inEpoch) {
    const selector = rule.inEpoch;
    hits = hits.filter((h) => anywhere(h) || inEpoch(h, selector, ctx));
    narrowed.push(`in epoch(${selector})`);
  }
  if (rule.after) {
    const step = ctx.steps.find((s) => s.label === rule.after);
    if (!step) {
      const known = ctx.steps.map((s) => s.label).join(', ') || 'none';
      return { pass: false, evidence: [], message: `Expected a step labelled "${rule.after}", but the run has steps: ${known}.` };
    }
    const from = step.endedAt ?? step.startedAt;
    hits = hits.filter((h) => {
      if (anywhere(h)) return true;
      const at = judgedAt(h, ctx.index);
      return at !== undefined && at >= from;
    });
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
  /** Host of the response, set on a Set-Cookie sighting. */
  host?: string;
}

function cookieSightings(matchers: RegExp[], ctx: Context): CookieSighting[] {
  const out: CookieSighting[] = [];
  const wanted = (name: string) => matchers.some((m) => m.test(name));
  for (const response of ctx.responses) {
    const request = ctx.requests.get(response.requestId);
    const t = request?.t;
    const host = request && hostOf(request.url);
    for (const name of response.setCookieNames) if (wanted(name)) out.push({ name, evidence: response.requestId, t, source: 'Set-Cookie', ...(host && { host }) });
  }
  for (const checkpoint of ctx.checkpoints)
    for (const cookie of checkpoint.cookies) if (wanted(cookie.name)) out.push({ name: cookie.name, evidence: checkpoint.id, t: checkpoint.t, source: `checkpoint "${checkpoint.label}"` });
  return out;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** RFC 6265 domain-match: a leading dot is ignored, and the host is the domain or a subdomain of it. */
function domainMatches(host: string, cookieDomain: string): boolean {
  const domain = cookieDomain.replace(/^\./, '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

type Stored = 'stored' | 'notStored' | 'alreadySet' | 'unknown';

/** A checkpoint this close after the request may have run while the response was still arriving. */
const STORAGE_MARGIN_MS = 50;

const STORED_RANK: Record<Stored, number> = { stored: 3, notStored: 2, alreadySet: 1, unknown: 0 };

/**
 * Reads the checkpoints around the request. The last one before it holding the cookie means it was already set. Otherwise, one
 * more than the margin after the request with the cookie means stored, and some without it means not stored.
 */
function storedState(sighting: CookieSighting, ctx: Context): Stored {
  if (sighting.t === undefined || !sighting.host) return 'unknown';
  const t = sighting.t;
  const host = sighting.host;
  const holds = (c: { cookies: { name: string; domain: string }[] }) => c.cookies.some((k) => k.name === sighting.name && domainMatches(host, k.domain));
  const before = ctx.checkpoints.filter((c) => c.t !== undefined && c.t < t).sort((a, b) => b.t! - a.t!)[0];
  if (before && holds(before)) return 'alreadySet';
  const later = ctx.checkpoints.filter((c) => c.t !== undefined && c.t > t + STORAGE_MARGIN_MS);
  if (later.length === 0) return 'unknown';
  return later.some(holds) ? 'stored' : 'notStored';
}

const STORED_TEXT = { stored: 'stored by the browser', notStored: 'no later checkpoint has it', alreadySet: 'the cookie was already set before this response' };

function storageText(sightings: CookieSighting[], ctx: Context): { text: string; notStored: boolean } | undefined {
  const byName = new Map<string, Stored>();
  for (const sighting of sightings.filter((x) => x.source === 'Set-Cookie')) {
    const state = storedState(sighting, ctx);
    const previous = byName.get(sighting.name);
    if (previous === undefined || STORED_RANK[state] > STORED_RANK[previous]) byName.set(sighting.name, state);
  }
  const named = (want: Stored) => [...byName].filter(([, state]) => state === want).map(([name]) => guardFieldName(name)).sort();
  const stored = named('stored');
  const notStored = named('notStored');
  const alreadySet = named('alreadySet');
  const groups = [
    { state: 'stored', names: stored, mixed: 'stored by the browser' },
    { state: 'notStored', names: notStored, mixed: 'no later checkpoint has' },
    { state: 'alreadySet', names: alreadySet, mixed: 'the cookie was already set before this response' },
  ] as const;
  const present = groups.filter((g) => g.names.length);
  if (!present.length) return undefined;
  const text = present.length === 1 ? STORED_TEXT[present[0]!.state] : present.map((g) => `${g.mixed}: ${listNames(g.names)}`).join('; ');
  return { text, notStored: notStored.length > 0 };
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
  const headerOnly = sources.length === 1 && sources[0] === 'Set-Cookie';
  const requests = new Set(sightings.map((s) => s.evidence)).size;
  const storage = sightings.length ? storageText(sightings, ctx) : undefined;
  const count = headerOnly ? `${requests} request${requests === 1 ? '' : 's'}` : `${total} before narrowing`;
  const found = sightings.length
    ? `found ${listNames(names)} from ${sources.join(' and ')} (${count})${storage ? `; ${storage.text}` : ''}${sources.some((s) => s !== 'Set-Cookie') ? '. A checkpoint shows the cookie was present then, not when it was set' : ''}`
    : `found no matching cookie (${total} before narrowing)`;
  const expected = rule.kind === 'must' ? `Expected a matching cookie${where}` : `Expected no matching cookie${where}`;
  const stubbed = low && rule.kind === 'mustNot' && ctx.networkMode === 'stub';
  return {
    pass: low,
    evidence,
    message: `${expected}, ${found}.${stubbed ? ` ${STUB_NO_COOKIES}` : ''}`,
    ...(stubbed && { note: 'stubNoCookies' as const }),
    ...(storage?.notStored && { note: 'cookieNotStored' as const }),
  };
}

const NOT_RECORDED = 'cannot evaluate: field names not recorded';
const BODY_CUT = 'cannot evaluate: body not fully recorded';
const VENDOR_IGNORE: Record<string, readonly string[]> = { ga4: GA4_BODY_ONLY_IGNORE, meta: META_BODY_ONLY_IGNORE, 'meta-capi': META_CAPI_BODY_ONLY_IGNORE, sgtm: SGTM_BODY_ONLY_IGNORE };

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

/** `**.name` matches `name` at any depth, on a dot boundary. Otherwise `*` matches any characters. */
function fieldGlob(pattern: string): RegExp {
  if (!pattern.startsWith('**.')) return globToRegExp(pattern);
  return new RegExp(`^(?:.*\\.)?${globToRegExp(pattern.slice(3)).source.slice(1, -1)}$`);
}

function nestedNames(plain: string[], hits: Hit[]): string[] {
  const wanted = new Set(plain);
  const found = new Set<string>();
  for (const hit of hits)
    for (const field of hit.fields ?? []) if (field.includes('.') && wanted.has(field.slice(field.lastIndexOf('.') + 1))) found.add(guardFieldName(field));
  return [...found].sort();
}

function evaluateBodyRule(rule: Rule, body: NonNullable<Rule['body']>, selected: Hit[], where: string, total: number, vacuous?: string): RuleOutcome {
  const tail = vacuous ? ` ${vacuous}` : '';
  const narrowed = `${selected.length} selected hit${selected.length === 1 ? '' : 's'}${where}`;
  if (body.has) {
    const matchers = body.has.map(fieldGlob);
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
    const undecided = Array.from({ length: unreadable.length }, (_, k) => countHolds(count, matching.length + k + 1)).some((holds) => holds !== low);
    if (undecided) return cannotEvaluate(unreadable, where);
    const names = [...new Set(matching.flatMap((m) => m.names))].sort();
    const evidence = matching.map((m) => m.hit.id);
    const found = matching.length
      ? `found ${matching.length} hit${matching.length === 1 ? '' : 's'} with body.has fields: ${listNames(names)}`
      : 'found no hit with the body.has fields';
    const expected = rule.kind === 'must' ? `Expected ${describeCount(count)} hits with body.has fields${where}` : `Expected no hit with body.has fields${where}`;
    const nested = matching.length ? [] : nestedNames(body.has.filter((n) => !n.includes('*')), selected);
    const nestedText = nested.length ? `; no top-level match; nested fields with this name: ${listNames(nested)}` : '';
    return { pass: low, evidence, message: `${expected}, ${found} (${total} before narrowing)${nestedText}.${tail}`, ...(nested.length && { note: 'nestedNameOnly' as const }) };
  }

  const only = body.only!;
  const allowed = [...only, ...(body.ignore ?? [])].map(fieldGlob);
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
    const have = idValue(hit, name, ctx);
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
function idValue(hit: Hit, name: string, ctx: Context): boolean | null | undefined {
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
  return prop === 'matchesIdentity' ? (hash.matchesIdentity ?? capiMatchesIdentity(hit, field, ctx.identity)) : undefined;
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

export interface JudgeIndex {
  hits: ReadonlyMap<string, Hit>;
  requests: ReadonlyMap<string, Request>;
}

export function judgeIndex(hits: readonly Hit[], requests: ReadonlyMap<string, Request> | readonly Request[]): JudgeIndex {
  return {
    hits: new Map(hits.map((h) => [h.id as string, h])),
    requests: requests instanceof Map ? requests : new Map((requests as readonly Request[]).map((r) => [r.id as string, r])),
  };
}

export function isServerHit(hit: Hit, index: JudgeIndex): boolean {
  return index.requests.get(hit.requestId)?.captured === 'serverContainer';
}

/** The browser hit a linked server hit takes its time and consent from. */
export function viaHitOf(hit: Hit, index: JudgeIndex): Hit | undefined {
  if (!hit.via || !isServerHit(hit, index)) return undefined;
  const via = index.hits.get(hit.via.hitId);
  return via && !isServerHit(via, index) ? via : undefined;
}

export function isUnlinkedServerHit(hit: Hit, index: JudgeIndex): boolean {
  return isServerHit(hit, index) && !viaHitOf(hit, index);
}

/**
 * The time a hit is placed by in consent epochs and time filters. A server container hit is placed
 * by the browser hit it came from, since its own time is when the container sent it on, which can
 * be after the visitor changed their answer. An unlinked server hit has none.
 */
export function judgedAt(hit: Hit, index: JudgeIndex): number | undefined {
  if (!isServerHit(hit, index)) return hit.t;
  return viaHitOf(hit, index)?.t;
}

function epochOf(hit: Hit, ctx: Context): EvalEpoch | undefined {
  const t = judgedAt(hit, ctx.index);
  return t === undefined ? undefined : epochForHit(ctx.epochs, t, ctx.grace);
}

function onlyProbableServerHits(evidence: readonly string[], ctx: Context): boolean {
  return (
    evidence.length > 0 &&
    evidence.every((id) => {
      const hit = ctx.index.hits.get(id);
      return hit?.via?.confidence === 'probable' && viaHitOf(hit, ctx.index) !== undefined;
    })
  );
}

/** Only an exact link can fail a run on time or consent. `timeJudged` marks results whose verdict depends on `judgedAt`; others keep their severity. */
function settleServerSends(
  pass: boolean,
  evidence: readonly string[],
  severity: Severity | undefined,
  note: ResultNote | undefined,
  timeJudged: boolean,
  ctx: Context,
): { severity: Severity | undefined; note: ResultNote | undefined } {
  if (!pass && note === 'serverSendUnlinked') return { severity: 'warn', note };
  if (note || !timeJudged) return { severity, note };
  const judged = evidence.filter((id) => {
    const hit = ctx.index.hits.get(id);
    return !hit || !isUnlinkedServerHit(hit, ctx.index);
  });
  if (!onlyProbableServerHits(judged, ctx)) return { severity, note };
  if (judged.length < evidence.length && !pass) return { severity: 'warn', note: 'serverSendUnlinked' };
  return { severity: pass ? severity : 'warn', note: 'serverSendProbableLink' };
}

/**
 * A Google hit that carries any consent states its own consent, and a field it does not carry stays
 * unknown. Every other hit takes the state of the epoch it falls in.
 */
function effectiveConsent(hit: Hit, ctx: Context): ConsentState {
  return effectiveConsentAt(hit, ctx.epochs, ctx.grace, ctx.index);
}

/** The consent state the evaluator uses for a hit. `epochs` must be sorted by `startT`. A server hit needs `index` and takes its via hit's state. */
export function effectiveConsentAt(hit: Hit, epochs: readonly EvalEpoch[], graceMs: number, index?: JudgeIndex): ConsentState {
  const t = index ? judgedAt(hit, index) : hit.t;
  if (t === undefined) return { analytics: 'unknown', ads: 'unknown', adUserData: 'unknown', adPersonalization: 'unknown' };
  // A linked server hit has the consent signals of its via hit, placed at the time `judgedAt` gives.
  const source = (index && viaHitOf(hit, index)) || hit;
  const base = epochForHit(epochs, t, graceMs)?.state;
  const own = GOOGLE_VENDORS.has(source.vendor) && consentFields.some((f) => source.consent[f] !== 'unknown');
  const pick = (f: ConsentField): ConsentValue => {
    if (own) return source.consent[f];
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
  if (isUnlinkedServerHit(hit, ctx.index)) return false;
  const epoch = epochOf(hit, ctx);
  return !epoch || epoch.label === 'undecided';
}

function isBeforeConsent(hit: Hit, ctx: Context): boolean {
  if (isUnlinkedServerHit(hit, ctx.index)) return false;
  const epoch = epochOf(hit, ctx);
  return !epoch || (epoch === ctx.epochs[0] && epoch.label === 'undecided');
}

function inEpoch(hit: Hit, selector: string, ctx: Context): boolean {
  if (isUnlinkedServerHit(hit, ctx.index)) return false;
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
// Only these vendors document plain city, postal code and country. The Conversions API requires them hashed.
const PLAIN_ADDRESS_VENDORS = new Set(['sgtm']);
const DIGEST_SHAPE = /^(?:[0-9a-f]{64}|[A-Za-z0-9+/_-]{43}=?)$/i;

function allForms(h: HashForms): string[] {
  return [h.hex, h.base64, h.base64url];
}

type HashVerdict = 'plain' | 'match' | 'unhashed' | 'wrong';

/** The field a param belongs to. The Conversions API indexes further values (`user_data.city.1`); every check uses the base. */
function identityParamName(vendor: string, name: string): string {
  return vendor === 'meta-capi' ? metaCapiBaseParam(name) : name;
}

/** Judges one hit param against the run identity. Undefined for a param that is not an identity field or is empty. */
function hashJudge(identity: Identity): (vendor: string, name: string, value: string) => HashVerdict | undefined {
  const emailHashes = new Set(allForms(hashEmail(identity.email)));
  const phone = hashPhone(identity.phone);
  const phoneHashes = new Set([...allForms(phone), ...allForms(sha256(identity.phone.replace(/\D/g, '')))]);
  const plain = new Set([identity.email.toLowerCase(), identity.phone.toLowerCase(), identity.phone.replace(/\D/g, '')]);
  // A literal fill value stands in for a field the checkout would not take as generated, such as a German city,
  // so it can match a name or address hash. An email or phone must still be the identity's own.
  const extra = identity.extra ?? [];
  return (vendor, rawName, value) => {
    const name = identityParamName(vendor, rawName);
    const field = FIELD_PARAMS[name]?.(identity);
    const accepted = field === undefined ? [] : [field, ...extra];
    const known = EMAIL_PARAM.test(name)
      ? emailHashes
      : PHONE_PARAM.test(name)
        ? phoneHashes
        : field !== undefined
          ? fieldHashes(...accepted)
          : undefined;
    if (!known || !value) return undefined;
    if (PLAIN_ADDRESS_PARAMS.has(name) && PLAIN_ADDRESS_VENDORS.has(vendor) && !DIGEST_SHAPE.test(value)) return 'plain';
    if (known.has(value)) return 'match';
    const typed = value.trim().toLowerCase();
    return plain.has(typed) || accepted.some((v) => v.trim().toLowerCase() === typed) ? 'unhashed' : 'wrong';
  };
}

/** Whether every value of a Conversions API field matches the run identity. Null when none can be checked. */
function capiMatchesIdentity(hit: Hit, field: string, identity: Identity | undefined): boolean | null {
  const base = Object.hasOwn(META_CAPI_PARAM_NAMES, field) ? META_CAPI_PARAM_NAMES[field] : undefined;
  if (hit.vendor !== 'meta-capi' || !identity || !base) return null;
  const judge = hashJudge(identity);
  const verdicts = Object.entries(hit.params)
    .filter(([name]) => metaCapiBaseParam(name) === base)
    .map(([name, value]) => judge(hit.vendor, name, value))
    .filter((v) => v !== undefined);
  return verdicts.length === 0 ? null : verdicts.every((v) => v === 'match');
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
  const judge = hashJudge(identity);
  const withHash: string[] = [];
  const wrong: string[] = [];
  const unhashed: string[] = [];
  const wrongFields = new Set<string>();
  const wrongParams = new Set<string>();
  const matchedFields = new Set<string>();
  const unhashedFields = new Set<string>();
  const plainAddressFields = new Set<string>();
  const uncheckedFields = new Set<string>();
  for (const hit of hits) {
    let seen = false;
    let bad = false;
    let raw = false;
    if (hit.vendor === 'meta') {
      for (const id of Object.keys(hit.ids)) if (id !== 'hashedEmail' && id !== 'hashedPhone') uncheckedFields.add(guardFieldName(id));
    }
    for (const [name, value] of Object.entries(hit.params)) {
      const verdict = judge(hit.vendor, name, value);
      if (!verdict) continue;
      const label = fieldLabel(identityParamName(hit.vendor, name));
      if (verdict === 'plain') {
        plainAddressFields.add(label);
        continue;
      }
      seen = true;
      if (verdict === 'match') {
        matchedFields.add(label);
        continue;
      }
      bad = true;
      if (verdict === 'unhashed') {
        raw = true;
        unhashedFields.add(label);
      } else {
        wrongFields.add(label);
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
  if (!withHash.length && uncheckedFields.size) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      message: `${several ? 'none of the hits carried a' : 'the hit carried no'} hashed email or phone, only ${joinLabels(uncheckedFields)} that Tagreeve does not check.`,
    };
  }
  if (!withHash.length && plainAddressFields.size) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      message: `${several ? 'none of the hits carried a' : 'the hit carried no'} hashed identity field, only plain ${joinLabels(plainAddressFields)} that Tagreeve does not check.`,
    };
  }
  if (!withHash.length) {
    return {
      pass: false,
      evidence: hits.map((h) => h.id),
      message: `${several ? 'none of the hits carried any' : 'the hit carried no'} identity fields (no hashed or plain email, phone, name or address); matching done server side, for example by a conversions API, is not visible to Tagreeve.`,
    };
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

/** Built-in checks whose default is not `fail`. */
const DEFAULT_SEVERITY: Partial<Record<BuiltinName, Severity>> = { earlyIdentifiers: 'warn' };

function builtInChecks(
  records: readonly Input[],
  scenario: Scenario,
  ctx: Context,
  addResult: (expectation: string, pass: boolean, evidence: string[], message: string, severity?: Severity, note?: ResultNote, timeJudged?: boolean) => void,
) {
  const add = (name: BuiltinName, pass: boolean, evidence: string[], message: string, note?: ResultNote, timeJudged = false) =>
    addResult(
      `builtin: ${name}`,
      pass,
      evidence,
      message,
      scenario.options.builtins?.[name] ?? DEFAULT_SEVERITY[name] ?? 'fail',
      note,
      timeJudged,
    );
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

  for (const check of [deniedIdentifiersCheck, earlyIdentifiersCheck]) {
    const passes = (c: Context) => {
      let pass = true;
      check(scenario, c, (_name, p, _evidence, _message, note) => void (pass = p || note === 'serverSendUnlinked'));
      return pass;
    };
    check(scenario, ctx, (name, pass, evidence, message, note) =>
      add(name, pass, evidence, message, note ?? (pass && passRestsOnProbableLink(ctx, passes) ? 'serverSendProbableLink' : undefined), pass || failureRestsOnProbableLink(ctx, passes)),
    );
  }

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

/** Unlinked server hits that carry identifiers, or whose identifiers cannot be read. No consent state applies to them. */
function unjudgedIdentifiers(ctx: Context): Hit[] {
  return ctx.hits.filter((h) => isUnlinkedServerHit(h, ctx.index) && (!h.idFields || !h.fields || h.idFields.length > 0 || h.fieldsComplete === false));
}

function cannotJudgeUnlinked(hits: readonly Hit[], when: string): { evidence: string[]; message: string } {
  const n = hits.length;
  return {
    evidence: hits.map((h) => h.id),
    message: `Cannot evaluate: ${n} server container hit${n === 1 ? ' has' : 's have'} no link to a browser hit and carr${n === 1 ? 'ies' : 'y'} identifiers, so no consent state applies to ${n === 1 ? 'it' : 'them'} ${when}.`,
  };
}

function identifierClasses(idFields: readonly string[], fields: readonly string[], extra: readonly RegExp[]): Map<string, IdentifierClass> {
  const classes = new Map<string, IdentifierClass>(idFields.map((n) => [n, identifierClass(n)]));
  for (const n of fields) if (!classes.has(n) && extra.some((re) => re.test(n))) classes.set(n, 'analytics');
  return classes;
}

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
    const classes = identifierClasses(hit.idFields, hit.fields, extra);
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
    const unjudged = unjudgedIdentifiers(ctx);
    add(
      'deniedIdentifiers',
      false,
      [...leaking.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${leaking.length} hit${leaking.length === 1 ? ' carries' : 's carry'} identifiers while consent is denied: ${shown}${more}.${cut}${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, 'for denied consent').message}` : ''}`,
    );
  } else if (unreadable.length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const notRecorded = unreadable.some((h) => !h.idFields || !h.fields);
    add(
      'deniedIdentifiers',
      false,
      [...unreadable.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} hit${unreadable.length === 1 ? '' : 's'} sent while consent is denied.${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, 'for denied consent').message}` : ''}`,
      notRecorded ? 'fieldsNotRecorded' : 'cannotEvaluateBody',
    );
  } else if (unjudgedIdentifiers(ctx).length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const { evidence, message } = cannotJudgeUnlinked(unjudged, 'for denied consent');
    add('deniedIdentifiers', false, evidence, message, 'serverSendUnlinked');
  } else {
    add('deniedIdentifiers', true, [], 'Expected no identifiers on hits sent while consent is denied, found none.');
  }
}

/** Hits before the first consent answer. Each field belongs to one check: a denied signal is left to `deniedIdentifiers`, so a hit with one denied and one unknown field is in both results. */
function earlyIdentifiersCheck(
  scenario: Scenario,
  ctx: Context,
  add: (name: BuiltinName, pass: boolean, evidence: string[], message: string, note?: ResultNote) => void,
) {
  const extra = (scenario.options.identifierFields ?? []).map(globToRegExp);
  const early: Hit[] = [];
  const unreadable: Hit[] = [];
  const found = new Map<string, Set<string>>();
  for (const hit of ctx.hits) {
    if (!isBeforeConsent(hit, ctx)) continue;
    if (!hit.idFields || !hit.fields) {
      unreadable.push(hit);
      continue;
    }
    const state = effectiveConsent(hit, ctx);
    let flagged = false;
    for (const [name, cls] of identifierClasses(hit.idFields, hit.fields, extra)) {
      const signal = identifierSignal(cls, state);
      if (signal.value !== 'unknown') continue;
      flagged = true;
      const key = `${hit.vendor}\0${signal.field}`;
      found.set(key, (found.get(key) ?? new Set()).add(name));
    }
    if (flagged) early.push(hit);
    else if (hit.fieldsComplete === false) unreadable.push(hit);
  }
  const hitsWord = (n: number) => `hit${n === 1 ? '' : 's'}`;
  if (early.length > 0) {
    const groups = [...found].map(([key, names]) => {
      const [vendor, signal] = key.split('\0');
      return `${vendor} ${listNames([...names].sort())} (${signal} unknown)`;
    });
    const shown = groups.slice(0, MAX_LISTED).join(', ');
    const more = groups.length > MAX_LISTED ? `, and ${groups.length - MAX_LISTED} more` : '';
    const cut = unreadable.length > 0 ? ` ${unreadable.length} more ${hitsWord(unreadable.length)} could not be read.` : '';
    const unjudged = unjudgedIdentifiers(ctx);
    add(
      'earlyIdentifiers',
      false,
      [...early.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${early.length} ${hitsWord(early.length)} ${early.length === 1 ? 'carries' : 'carry'} identifiers before the consent answer: ${shown}${more}.${cut}${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, 'before the consent answer').message}` : ''}`,
    );
  } else if (unreadable.length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const notRecorded = unreadable.some((h) => !h.idFields || !h.fields);
    add(
      'earlyIdentifiers',
      false,
      [...unreadable.map((h) => h.id), ...unjudged.map((h) => h.id)],
      `${notRecorded ? NOT_RECORDED : BODY_CUT}: ${unreadable.length} ${hitsWord(unreadable.length)} sent before the consent answer.${unjudged.length > 0 ? ` ${cannotJudgeUnlinked(unjudged, 'before the consent answer').message}` : ''}`,
      notRecorded ? 'fieldsNotRecorded' : 'cannotEvaluateBody',
    );
  } else if (unjudgedIdentifiers(ctx).length > 0) {
    const unjudged = unjudgedIdentifiers(ctx);
    const { evidence, message } = cannotJudgeUnlinked(unjudged, 'before the consent answer');
    add('earlyIdentifiers', false, evidence, message, 'serverSendUnlinked');
  } else {
    add('earlyIdentifiers', true, [], 'Expected no identifiers on hits sent before the consent answer, found none.');
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

const BINARY_CONTENT_TYPE = /^(?:application\/(?:octet-stream|gzip|x-gzip|zip|zlib|x-protobuf|protobuf|grpc|msgpack|x-msgpack)|image\/(?!svg\+xml)[^;\s]+|audio\/[^;\s]+|video\/[^;\s]+)\s*(?:;|$)/i;
const BINARY_SHARE = 0.1;
const BINARY_MIN_LENGTH = 16;

// The recorder keeps bodies as UTF-8 decoded text, so most high bytes of a compressed body are U+FFFD. The byte check runs whatever the
// content-type says, because beacons often send compressed bytes as text/plain.
function headersSayBinary(headers: Record<string, string>): boolean {
  const header = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1]?.trim().toLowerCase() ?? '';
  const encoding = header('content-encoding');
  if (encoding !== '' && encoding !== 'identity') return true;
  return BINARY_CONTENT_TYPE.test(header('content-type'));
}

function isBinaryBody(headers: Record<string, string>, body: string): boolean {
  if (headersSayBinary(headers)) return true;
  return isBinaryText(body);
}

function isBinaryText(body: string): boolean {
  if (body.length < BINARY_MIN_LENGTH) return false;
  return binaryShare(body) >= BINARY_SHARE;
}

interface ScanText {
  text: string;
  where: string;
  /** Marks a text named by a raw body path. A hit parameter path names the same value better. */
  leaf?: true;
  /** A JSON path prefix. It names a key, so a phone-shaped run of digits in it is not a value. */
  name?: true;
}

// A leaf is scanned as `name=value` so a key that holds an email is found.
function leafTexts(text: string): ScanText[] {
  const out: ScanText[] = [];
  const isJson = /^\s*[{[]/.test(text);
  if (!isJson) {
    // Raw substrings, so the scan decodes `+` and `%XX` the same way as in the base text.
    for (const segment of text.split('&')) {
      const eq = segment.indexOf('=');
      if (eq < 0 || eq === segment.length - 1) continue;
      const rawName = segment.slice(0, eq).replace(/\[\]|%5B%5D/gi, '');
      const [decoded] = new URLSearchParams(segment).keys();
      out.push({ text: `${rawName}${segment.slice(eq)}`, where: decoded ? guardFieldName(decoded) : 'the body', leaf: true });
    }
    return out;
  }
  const { entries, parsed } = bodyEntries({ postData: text });
  if (parsed) {
    // The ID-key exemptions look at the key right before the value, so a JSON path is cut to its last segment.
    for (const { name, value } of entries) {
      const path = name.split('.');
      path[path.length - 1] = path[path.length - 1]!.replace(/\[\]/g, '');
      const where = guardFieldName(name);
      if (path.length > 1) out.push({ text: path.slice(0, -1).join('.'), where, leaf: true, name: true });
      out.push({ text: `${path[path.length - 1]}=${value}`, where, leaf: true });
    }
  }
  return out;
}

// Headers, preamble, epilogue and text parts stay in the text, so nothing a whole-body scan finds is lost.
// A body that is not binary as a whole keeps every part, whatever a part's headers say, as a whole-body scan reads it.
function withoutBinaryParts(split: MultipartBody, wholeIsBinary: boolean): string {
  const cut = (part: { headers: Record<string, string>; body: string }) => wholeIsBinary && isBinaryBody(part.headers, part.body);
  return split.chunks
    .map(({ raw, part }) => (part && cut(part) ? raw.slice(0, part.bodyStart) : raw))
    .join(`--${split.boundary}`);
}

// A body that is not binary as a whole stays whole, as a whole-body scan reads it. Otherwise only its binary lines are cut.
function withoutBinaryLines(body: string): string {
  if (!isBinaryText(body)) return body;
  return body.split(/(?<=\n)/).filter((line) => !isBinaryText(line.replace(/\r?\n$/, ''))).join('');
}

// The base text is the whole body minus binary pieces. Each part or line also gets leaf texts, so a value reports with its path.
function bodyTexts(headers: Record<string, string>, body: string): ScanText[] {
  if (body === '' || headersSayBinary(headers)) return [];
  const split = splitMultipart(body, headers);
  if (split?.parts.length) {
    const wholeIsBinary = isBinaryText(body);
    const named = split.parts.flatMap((part) => {
      const name = multipartPartName(part);
      if (wholeIsBinary && isBinaryBody(part.headers, part.body)) return [];
      return name === undefined ? leafTexts(part.body) : [{ text: `${name}=${part.body}`, where: guardFieldName(name), leaf: true as const }];
    });
    return [{ text: withoutBinaryParts(split, wholeIsBinary), where: 'the body' }, ...named];
  }
  const isJson = /^\s*[{[]/.test(body) && bodyEntries({ postData: body }).parsed;
  if (!isJson && /[\r\n]/.test(body.trim())) {
    const lines = body.split(/\r?\n/).filter((line) => line.trim() !== '' && !isBinaryText(line));
    return [{ text: withoutBinaryLines(body), where: 'the body' }, ...lines.flatMap(leafTexts)];
  }
  return isBinaryText(body) ? [] : [{ text: body, where: 'the body' }, ...leafTexts(body)];
}

// The base reads raw characters and a leaf decoded ones, so a JSON escape or a joined name shifts a value's edge. Such a twin is
// merged into the field's finding, never dropped, so nothing a whole-body scan finds is lost. Only a reading from the body itself
// merges, and only when it differs from the field's value by a few edge characters: a different value in the URL, or a longer
// value elsewhere, keeps its own finding.
const MAX_EDGE_SHIFT = 5;

// The shorter value must never stand alone in the body: a separate value that a longer one contains keeps its own finding.
function isEdgeShift(a: string, b: string, bodies: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length - short.length > MAX_EDGE_SHIFT || !long.includes(short)) return false;
  return bodies.every((raw) => {
    const text = raw.replaceAll('[]', '');
    const covered: [number, number][] = [];
    for (let i = text.indexOf(long); i >= 0; i = text.indexOf(long, i + 1)) covered.push([i, i + long.length]);
    for (let i = text.indexOf(short); i >= 0; i = text.indexOf(short, i + 1)) {
      if (!covered.some(([from, to]) => i >= from && i + short.length <= to)) return false;
    }
    return true;
  });
}

function mergeEdgeReadings(found: Map<string, { kind: string; where: Map<string, number> }>, bodies: string[]): void {
  const best = (f: { where: Map<string, number> }) => Math.min(...f.where.values());
  const valueOf = (key: string, kind: string) => key.slice(kind.length + 1);
  const fields = [...found].filter(([, f]) => best(f) < 2);
  for (const [key, f] of [...found]) {
    if (best(f) < 2 || [...f.where.keys()].some((w) => w !== 'the body')) continue;
    const value = valueOf(key, f.kind);
    const twin = fields.find(([k, other]) => other.kind === f.kind && isEdgeShift(valueOf(k, other.kind), value, bodies));
    if (!twin) continue;
    for (const [w, tier] of f.where) twin[1].where.set(w, Math.min(tier, twin[1].where.get(w) ?? tier));
    found.delete(key);
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
  const byRequest = new Map<string, { texts: ScanText[]; hitIds: string[]; stepId: string | null }>();
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
    const texts = slot(request.id, request.stepId).texts;
    for (const text of [url, ...pathSegments(url)]) texts.push({ text, where: 'the URL' });
    for (const text of bodyTexts(request.headers, persisted.postData)) texts.push(text);
  }
  for (const hit of hits) {
    const entry = slot(hit.requestId, hit.stepId);
    entry.hitIds.push(hit.id);
    for (const [key, value] of Object.entries(hit.params)) entry.texts.push({ text: `${key}=${value}`, where: guardFieldName(key) });
  }
  const stableHashes = findStableHashes(
    [...byRequest].flatMap(([requestId, entry]) => entry.texts.map(({ text }) => ({ requestId, text }))),
  );
  const out: ForeignData[] = [];
  for (const [requestId, entry] of byRequest) {
    const found = new Map<string, { kind: string; where: Map<string, number> }>();
    for (const { text, where, leaf, name } of entry.texts) {
      const tier = where === 'the URL' || where === 'the body' ? 2 : leaf ? 1 : 0;
      for (const m of scan(text, identity, { stableHashes })) {
        if (name && m.kind === 'phone') continue;
        const key = `${m.kind}:${m.value}`;
        const seen = found.get(key) ?? { kind: m.kind, where: new Map<string, number>() };
        seen.where.set(where, Math.min(tier, seen.where.get(where) ?? tier));
        found.set(key, seen);
      }
    }
    if (found.size === 0) continue;
    mergeEdgeReadings(
      found,
      entry.texts.filter((t) => t.where === 'the body' && !t.leaf).map((t) => t.text),
    );
    const kinds = [...new Set([...found.values()].map((f) => f.kind))].join(', ');
    const places = new Set<string>();
    for (const { where } of found.values()) {
      const best = Math.min(...where.values());
      for (const [w, tier] of where) if (tier === best) places.add(w);
    }
    const shown = [...places].sort();
    const in_ = shown.length > 5 ? `${shown.slice(0, 5).join(', ')} and ${shown.length - 5} more` : shown.join(', ');
    const step = entry.stepId ? ` in step ${entry.stepId}` : '';
    out.push({
      requestId,
      detail: `request ${requestId}${step} carries ${found.size} ${kinds} value(s) that are not from the run identity, in ${in_}`,
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
  index?: JudgeIndex,
): Map<Hit, ConsentEpoch | undefined> {
  const sorted = [...epochs].sort((a, b) => a.startT - b.startT);
  const placed = (h: Hit) => {
    const t = index ? judgedAt(h, index) : h.t;
    return t === undefined ? undefined : epochForHit(sorted, t, graceMs);
  };
  return new Map(hits.filter((h) => !GOOGLE_VENDORS.has(h.vendor) || (index && isServerHit(h, index))).map((h) => [h, placed(h)]));
}
