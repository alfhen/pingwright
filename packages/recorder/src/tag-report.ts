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

type Bad = { bad: string };

const isBad = (value: unknown): value is Bad => typeof value === 'object' && value !== null && 'bad' in value;

function parseTag(raw: unknown): TagStatus | Bad {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { bad: 'tag' };
  const tag = raw as Record<string, unknown>;
  if (typeof tag.id !== 'string' || tag.id.length > MAX_TAG_ID || !TAG_ID.test(tag.id)) return { bad: 'tagId' };
  if (typeof tag.status !== 'string' || tag.status.length > MAX_STATUS) return { bad: 'tagStatus' };
  const time = tag.executionTime ?? null;
  if (time !== null && (typeof time !== 'number' || !Number.isFinite(time))) return { bad: 'executionTime' };
  const name = tag.name ?? null;
  if (name !== null && (typeof name !== 'string' || name.length > MAX_NAME)) return { bad: 'tagName' };
  return { id: tag.id, name, status: tag.status, executionTime: time };
}

/**
 * Reads what the tag reporter template sent. Only the known keys are kept. A payload that does not fit becomes an
 * `InvalidReport` that names the failing field and holds none of the payload.
 */
export function parseTagReport(payload: unknown, side: TagReport['side'], ctx: TagReportContext): ParsedTagReport {
  const fail = (what: string): ParsedTagReport => ({
    ok: false,
    invalid: { type: 'invalidReport', id: newId('collectorReport'), runId: ctx.runId, t: ctx.t, error: `tagReport:${what}`, body: '' },
  });
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return fail('payload');
  const p = payload as Record<string, unknown>;
  if (typeof p.container !== 'string' || !CONTAINER.test(p.container)) return fail('container');
  if (typeof p.event !== 'string' || p.event.length > MAX_EVENT) return fail('event');
  const uniqueId = p.gtmUniqueEventId ?? null;
  if (uniqueId !== null && (typeof uniqueId !== 'number' || !Number.isFinite(uniqueId))) return fail('gtmUniqueEventId');
  const version = p.version ?? null;
  if (version !== null && (typeof version !== 'string' || version.length > MAX_VERSION)) return fail('version');
  if (!Array.isArray(p.tags) || p.tags.length > MAX_TAGS) return fail('tags');
  const tags: TagStatus[] = [];
  for (const raw of p.tags) {
    const tag = parseTag(raw);
    if (isBad(tag)) return fail(tag.bad);
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
