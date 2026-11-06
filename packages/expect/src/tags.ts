import { globToRegExp, valueKinds, type GtmOverrideTag, type ResultNote, type TagReport } from '@tagreeve/core';
import { isValueSegment, OTHER_NAME } from '@tagreeve/decoders';
import { countHolds, describeCount, type Rule } from './scenario.ts';

export const TAG_REPORTER_HINT = 'tagreeve template web --json';

const MAX_LISTED = 5;
const STATUS_WORD = /^[a-z_]{1,20}$/;
const ID_WORD = /^[\w.-]{1,40}$/;

export interface ExpectedTags {
  container: string;
  tags: readonly GtmOverrideTag[];
}

export interface TagRuleOutcome {
  pass: boolean;
  evidence: string[];
  message: string;
  note?: ResultNote;
}

export interface TagRuleInput {
  reports: readonly TagReport[];
  expected: ExpectedTags | undefined;
  /** Reports before this time are ignored. */
  window?: { at: number; text: string };
}

const NAME_SEPARATORS = /[\s/=:?&#|,;._+()[\]{}<>'"`]+/;

/** A tag name may hold spaces and path or query text, so it is checked part by part. A name that holds an email, a phone or a value-like part reads `(other)`. */
export function maskTagName(name: string): string {
  const kinds = valueKinds(name);
  if (kinds.has('email') || kinds.has('phone')) return OTHER_NAME;
  return name.split(NAME_SEPARATORS).some((part) => isValueSegment(part)) ? OTHER_NAME : name;
}

export function maskTagId(id: string): string {
  return ID_WORD.test(id) ? id : OTHER_NAME;
}

function maskStatus(status: string): string {
  return STATUS_WORD.test(status) ? status : OTHER_NAME;
}

/** The name in the report, else the one in `expectedTags` for that container. */
function nameOf(report: TagReport, tag: { id: string; name: string | null }, expected: ExpectedTags | undefined): { name: string; from: 'report' | 'expectedTags' } | undefined {
  if (tag.name) return { name: tag.name, from: 'report' };
  const named = report.container === expected?.container ? expected.tags.find((t) => t.id === tag.id)?.name : undefined;
  return named ? { name: named, from: 'expectedTags' } : undefined;
}

export const tagLabel = (id: string, name: string | null | undefined): string => (name ? `${maskTagId(id)} ${maskTagName(name)}` : maskTagId(id));

function listLabels(labels: string[]): string {
  return labels.length > MAX_LISTED ? `${labels.slice(0, MAX_LISTED).join(', ')} and ${labels.length - MAX_LISTED} more` : labels.join(', ');
}

/** Reads tag reports only. The evidence is the `tag_` record IDs of the reports that hold a match. */
export function evaluateTagRule(rule: Rule, input: TagRuleInput): TagRuleOutcome {
  const selector = rule.tag!;
  const reports = input.reports.filter((r) => (!selector.container || r.container === selector.container) && (!selector.side || r.side === selector.side));
  if (reports.length === 0) {
    const from = selector.container ?? 'any container';
    return { pass: false, evidence: [], message: `cannot evaluate: no tag report from ${from}${selector.side ? ` on the ${selector.side} side` : ''}.`, note: 'noTagReports' };
  }

  const narrowed: string[] = [];
  let kept = reports;
  if (selector.event) {
    const event = globToRegExp(selector.event);
    kept = kept.filter((r) => event.test(r.event));
    narrowed.push(`for event ${maskTagName(selector.event)}`);
  }
  if (input.window) {
    const { at, text } = input.window;
    kept = kept.filter((r) => r.t >= at);
    narrowed.push(text);
  }
  const statuses = selector.status && new Set(selector.status);
  const byName = selector.name ? globToRegExp(selector.name) : undefined;

  const matches: { report: TagReport; id: string; name: string | null }[] = [];
  const unknown = new Set<string>();
  let unknownEntries = 0;
  for (const report of kept)
    for (const tag of report.tags) {
      if (statuses && !statuses.has(tag.status)) continue;
      if (byName) {
        const named = nameOf(report, tag, input.expected);
        if (!named) {
          unknown.add(report.id);
          unknownEntries += 1;
        } else if (byName.test(named.name)) matches.push({ report, id: tag.id, name: named.name });
      } else if (tag.id === selector.id) matches.push({ report, id: tag.id, name: nameOf(report, tag, input.expected)?.name ?? null });
    }

  const want = rule.kind === 'must' ? (rule.count ?? { op: '>=' as const, n: 1 }) : { op: '=' as const, n: 0 };
  const verdicts = new Set(Array.from({ length: unknownEntries + 1 }, (_, k) => countHolds(want, matches.length + k)));
  if (verdicts.size > 1) {
    return {
      pass: false,
      evidence: [...unknown],
      message: `cannot evaluate: ${unknownEntries} tag entr${unknownEntries === 1 ? 'y has' : 'ies have'} no name in the report or in expectedTags.`,
      note: 'tagNameUnknown',
    };
  }

  const where = narrowed.length ? ` ${narrowed.join(', ')}` : '';
  const evidence = [...new Set(matches.map((m) => m.report.id))];
  const labels = [...new Set(matches.map((m) => tagLabel(m.id, m.name)))];
  const found = matches.length
    ? `found ${matches.length} matching tag entr${matches.length === 1 ? 'y' : 'ies'} in ${evidence.length} report${evidence.length === 1 ? '' : 's'} (${listLabels(labels)})`
    : 'found none';
  const expected = rule.kind === 'must' ? `Expected ${describeCount(want)} matching tag entries${where}` : `Expected no matching tag entries${where}`;
  return { pass: countHolds(want, matches.length), evidence, message: `${expected}, ${found}.` };
}

export interface FiredTag {
  id: string;
  name: string | null;
  nameFrom: 'report' | 'expectedTags' | null;
  /** The number of tag entries, over all reports. */
  count: number;
  statuses: Record<string, number>;
}

export type TagsContainerSummary =
  | { reports: number; fired: FiredTag[]; notFired: { id: string; name: string | null }[] | null }
  | { reports: 0; hint: string };

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id, 'en', { numeric: true });

/** Counts, IDs and masked names. `notFired` is set only for the override container that sent a report. */
export function summarizeTags(reports: readonly TagReport[], expected: ExpectedTags | undefined): Record<string, TagsContainerSummary> | undefined {
  const out: Record<string, TagsContainerSummary> = {};
  const containers = [...new Set(reports.map((r) => r.container))].sort();
  for (const container of containers) {
    const own = reports.filter((r) => r.container === container);
    const fired = new Map<string, FiredTag>();
    for (const report of own)
      for (const tag of report.tags) {
        const entry = fired.get(tag.id) ?? { id: maskTagId(tag.id), name: null, nameFrom: null, count: 0, statuses: {} };
        const named = nameOf(report, tag, expected);
        if (named && (entry.nameFrom === null || (entry.nameFrom === 'expectedTags' && named.from === 'report'))) {
          entry.name = maskTagName(named.name);
          entry.nameFrom = named.from;
        }
        entry.count += 1;
        const status = maskStatus(tag.status);
        entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
        fired.set(tag.id, entry);
      }
    let notFired: { id: string; name: string | null }[] | null = null;
    if (expected?.container === container) {
      const web = new Set(own.filter((r) => r.side === 'web').flatMap((r) => r.tags.map((t) => t.id)));
      notFired = expected.tags
        .filter((t) => !web.has(t.id))
        .map((t) => ({ id: maskTagId(t.id), name: t.name ? maskTagName(t.name) : null }))
        .sort(byId);
    }
    out[container] = { reports: own.length, fired: [...fired.values()].sort(byId), notFired };
  }
  if (expected && !(expected.container in out)) out[expected.container] = { reports: 0, hint: TAG_REPORTER_HINT };
  return Object.keys(out).length ? out : undefined;
}
