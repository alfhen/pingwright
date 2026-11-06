import { newId, type DataLayerFrame, type Id, type InvalidReport, type TagReport, type TagStatus } from '@tagreeve/core';

export const TAG_REPORT_BINDING = 'tagreeveTagReport';

const MAX_EVENT = 256;
const MAX_VERSION = 32;
const MAX_TAGS = 500;
const MAX_TAG_ID = 32;
const MAX_STATUS = 32;
const MAX_NAME = 256;
const CONTAINER = /^GTM-[A-Z0-9]+$/;
const TAG_ID = /^[0-9]+$/;

export interface TagReportContext {
  runId: Id<'run'>;
  t: number;
  stepId: Id<'stp'> | null;
  frame?: DataLayerFrame;
}

export type ParsedTagReport =
  | { ok: true; report: TagReport; version: string | null }
  | { ok: false; invalid: InvalidReport };

type Bad = { bad: string; got: NonNullable<InvalidReport['got']> };

const isBad = (value: unknown): value is Bad => typeof value === 'object' && value !== null && 'bad' in value;

function typeClass(value: unknown): NonNullable<InvalidReport['got']> {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  return type === 'string' || type === 'number' || type === 'boolean' || type === 'undefined' ? type : 'object';
}

const bad = (what: string, value: unknown): Bad => ({ bad: what, got: typeClass(value) });

/** GTM gives tag IDs as numbers. A digit string (the rc.2 template) is accepted too. Returns null when neither fits. */
function digits(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  if (typeof value === 'string' && value.length <= MAX_TAG_ID && TAG_ID.test(value)) return value;
  return null;
}

function parseTag(raw: unknown): TagStatus | Bad {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('tag', raw);
  const tag = raw as Record<string, unknown>;
  const id = digits(tag.id);
  if (id === null) return bad('tagId', tag.id);
  if (typeof tag.status !== 'string' || tag.status.length > MAX_STATUS) return bad('tagStatus', tag.status);
  const time = tag.executionTime ?? null;
  if (time !== null && (typeof time !== 'number' || !Number.isFinite(time))) return bad('executionTime', time);
  const name = tag.name ?? null;
  if (name !== null && (typeof name !== 'string' || name.length > MAX_NAME)) return bad('tagName', name);
  return { id, name, status: tag.status, executionTime: time };
}

/**
 * Reads what the tag reporter template sent. Only the known keys are kept. A payload that does not fit becomes an
 * `InvalidReport` that names the failing field and holds none of the payload.
 */
export function parseTagReport(payload: unknown, side: TagReport['side'], ctx: TagReportContext): ParsedTagReport {
  const fail = (what: string, got: NonNullable<InvalidReport['got']>): ParsedTagReport => ({
    ok: false,
    invalid: {
      type: 'invalidReport',
      id: newId('collectorReport'),
      runId: ctx.runId,
      t: ctx.t,
      error: `tagReport:${what}`,
      got,
      body: '',
    },
  });
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return fail('payload', typeClass(payload));
  const p = payload as Record<string, unknown>;
  if (typeof p.container !== 'string' || !CONTAINER.test(p.container)) return fail('container', typeClass(p.container));
  if (typeof p.event !== 'string' || p.event.length > MAX_EVENT) return fail('event', typeClass(p.event));
  const uniqueId = p.gtmUniqueEventId ?? null;
  if (uniqueId !== null && (typeof uniqueId !== 'number' || !Number.isFinite(uniqueId))) return fail('gtmUniqueEventId', typeClass(uniqueId));
  const rawVersion = p.version ?? null;
  const version =
    typeof rawVersion === 'number' ? digits(rawVersion) : typeof rawVersion === 'string' && rawVersion.length <= MAX_VERSION ? rawVersion : null;
  if (rawVersion !== null && version === null) return fail('version', typeClass(rawVersion));
  if (!Array.isArray(p.tags) || p.tags.length > MAX_TAGS) return fail('tags', typeClass(p.tags));
  const tags: TagStatus[] = [];
  for (const raw of p.tags) {
    const tag = parseTag(raw);
    if (isBad(tag)) return fail(tag.bad, tag.got);
    tags.push(tag);
  }
  const report: TagReport = {
    type: 'tagReport',
    id: newId('tagReport'),
    runId: ctx.runId,
    stepId: ctx.stepId,
    container: p.container,
    side,
    t: ctx.t,
    event: p.event,
    gtmUniqueEventId: uniqueId,
    ...(ctx.frame ? { frame: { main: ctx.frame.main, n: ctx.frame.n } } : {}),
    tags,
  };
  return { ok: true, report, version };
}
