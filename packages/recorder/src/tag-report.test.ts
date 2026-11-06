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

  test('a number tag id becomes a decimal string', () => {
    const r = parseTagReport({ ...good(), tags: [{ id: 11, status: 'success' }] }, 'web', ctx);
    expect(r.ok && r.report.tags[0]!.id).toBe('11');
    const zero = parseTagReport({ ...good(), tags: [{ id: 0, status: 'success' }] }, 'web', ctx);
    expect(zero.ok && zero.report.tags[0]!.id).toBe('0');
  });

  test('a number version becomes a decimal string', () => {
    const r = parseTagReport({ ...good(), version: 12 }, 'web', ctx);
    expect(r.ok && r.version).toBe('12');
  });

  test.each([
    ['a float', 11.5],
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['a string with other characters', '1a'],
  ])('%s as a tag id is invalid', (_name, id) => {
    const bad = invalid({ ...good(), tags: [{ id, status: 'success' }] });
    expect(bad.error).toBe('tagReport:tagId');
  });

  test.each([
    ['a float', 1.5],
    ['a negative number', -3],
    ['a boolean', true],
    ['an object', {}],
  ])('%s as a version is invalid', (_name, version) => {
    expect(invalid({ ...good(), version }).error).toBe('tagReport:version');
  });

  test.each([
    ['payload', null, 'null'],
    ['payload', [1], 'array'],
    ['payload', 5, 'number'],
    ['container', { container: 5 }, 'number'],
    ['container', { container: 'nope' }, 'string'],
    ['tags', { tags: {} }, 'object'],
    ['tags', { tags: null }, 'null'],
    ['tagId', { tags: [{ id: true, status: 'success' }] }, 'boolean'],
    ['tagId', { tags: [{ id: 11.5, status: 'success' }] }, 'number'],
    ['tagId', { tags: [{ id: '1a', status: 'success' }] }, 'string'],
    ['tagId', { tags: [{ id: [1], status: 'success' }] }, 'array'],
    ['tagId', { tags: [{ status: 'success' }] }, 'undefined'],
    ['tag', { tags: [null] }, 'null'],
  ])('%s: got is the type class %s', (what, patch, got) => {
    const payload = what === 'payload' ? patch : { ...good(), ...(patch as object) };
    const bad = invalid(payload);
    expect(bad.error).toBe(`tagReport:${what}`);
    expect(bad.got).toBe(got);
    expect(Object.keys(bad).sort()).toEqual(['body', 'error', 'got', 'id', 'runId', 't', 'type']);
  });

  test('a rejected value is not kept in the invalid report', () => {
    const bad = invalid({ ...good(), container: 'planted-fake-value' });
    expect(JSON.stringify(bad)).not.toContain('planted-fake-value');
    expect(bad.got).toBe('string');
  });
});
