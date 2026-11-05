import { newId } from '@tagreeve/core';
import { describe, expect, test } from 'vitest';
import { parseTagReport } from './tag-report.ts';

const ctx = { runId: newId('run'), t: 1234, stepId: null, frame: { main: false, n: 2 } };
const good = () => ({
  v: 1,
  container: 'GTM-PWTEST1',
  event: 'purchase',
  gtmUniqueEventId: 7,
  version: '3',
  tags: [{ id: '11', status: 'success', executionTime: 4, name: 'GA4 - Config' }],
});

const invalid = (payload: unknown) => {
  const r = parseTagReport(payload, 'web', ctx);
  if (r.ok) throw new Error('expected an invalid report');
  return r.invalid;
};

describe('parseTagReport', () => {
  test('a valid payload becomes a web report with the context', () => {
    const r = parseTagReport(good(), 'web', ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.version).toBe('3');
    expect(r.report).toMatchObject({
      type: 'tagReport',
      runId: ctx.runId,
      stepId: null,
      container: 'GTM-PWTEST1',
      side: 'web',
      t: 1234,
      event: 'purchase',
      gtmUniqueEventId: 7,
      frame: { main: false, n: 2 },
      tags: [{ id: '11', name: 'GA4 - Config', status: 'success', executionTime: 4 }],
    });
  });

  test('unknown keys are dropped at every level', () => {
    const payload = { ...good(), extra: 'x', tags: [{ id: '11', status: 'success', executionTime: null, name: null, secret: 'x' }] };
    const r = parseTagReport(payload, 'web', ctx);
    expect(r.ok).toBe(true);
    const text = JSON.stringify(r.ok ? r.report : null);
    expect(text).not.toContain('extra');
    expect(text).not.toContain('secret');
  });

  test('a missing id, version, execution time and name read as null', () => {
    const { container, event } = good();
    const r = parseTagReport({ container, event, tags: [{ id: '5', status: 'failure' }] }, 'web', ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBeNull();
      expect(r.report.gtmUniqueEventId).toBeNull();
      expect(r.report.tags[0]).toEqual({ id: '5', name: null, status: 'failure', executionTime: null });
    }
  });

  test.each([
    ['a bad container', { container: 'gtm-lower' }, 'container'],
    ['a container with a trailing newline', { container: 'GTM-AB\n' }, 'container'],
    ['an event over 256 characters', { event: 'e'.repeat(257) }, 'event'],
    ['a non-string event', { event: 5 }, 'event'],
    ['a string unique event id', { gtmUniqueEventId: '7' }, 'gtmUniqueEventId'],
    ['a version over 32 characters', { version: 'v'.repeat(33) }, 'version'],
    ['tags that are not a list', { tags: {} }, 'tags'],
    ['more than 500 tags', { tags: Array.from({ length: 501 }, () => ({ id: '1', status: 'success' })) }, 'tags'],
    ['a tag id that is not digits', { tags: [{ id: 'abc', status: 'success' }] }, 'tagId'],
    ['a tag id over 32 characters', { tags: [{ id: '1'.repeat(33), status: 'success' }] }, 'tagId'],
    ['a status over 32 characters', { tags: [{ id: '1', status: 's'.repeat(33) }] }, 'tagStatus'],
    ['a status that is not a string', { tags: [{ id: '1', status: 1 }] }, 'tagStatus'],
    ['an execution time that is not a number', { tags: [{ id: '1', status: 'success', executionTime: '4' }] }, 'executionTime'],
    ['a name over 256 characters', { tags: [{ id: '1', status: 'success', name: 'n'.repeat(257) }] }, 'tagName'],
    ['a tag that is not an object', { tags: ['11'] }, 'tag'],
  ])('%s is an invalid report', (_name, patch, what) => {
    const bad = invalid({ ...good(), ...patch });
    expect(bad.error).toBe(`tagReport:${what}`);
    expect(bad.body).toBe('');
  });

  test('the limits themselves are accepted', () => {
    const payload = {
      ...good(),
      event: 'e'.repeat(256),
      version: 'v'.repeat(32),
      tags: Array.from({ length: 500 }, () => ({ id: '1'.repeat(32), status: 's'.repeat(32), name: 'n'.repeat(256) })),
    };
    expect(parseTagReport(payload, 'web', ctx).ok).toBe(true);
  });

  test('a payload that is not an object is invalid and its text is not kept', () => {
    for (const payload of [null, 'GTM-PWTEST1 secret', [good()], 5]) {
      const bad = invalid(payload);
      expect(bad.error).toBe('tagReport:payload');
      expect(JSON.stringify(bad)).not.toContain('secret');
    }
  });
});
