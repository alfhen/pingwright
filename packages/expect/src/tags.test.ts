import { newId, type TagReport } from '@tagreeve/core';
import { expect, test } from 'vitest';
import { evaluate } from './evaluate.ts';
import { parseScenario } from './scenario.ts';
import { summarizeTags } from './tags.ts';

const runId = newId('run');

function report(over: Partial<TagReport> & { tags: TagReport['tags'] }): TagReport {
  return { type: 'tagReport', id: newId('tagReport'), runId, stepId: null, container: 'GTM-PWTEST1', side: 'web', t: 100, event: 'gtm.js', gtmUniqueEventId: 1, ...over };
}

const tag = (id: string, name: string | null, status = 'success') => ({ id, name, status, executionTime: 1 });

const OVERRIDE = { container: 'GTM-PWTEST1', gtmPreview: 'env-1', gtmAuth: '[redacted]', applied: [], expectedTags: [{ id: '13', name: 'Meta - PageView' }, { id: '45', name: 'GA4 - Purchase' }] };

function run(rules: string, records: unknown[], override: unknown = null) {
  const scenario = parseScenario(`start: /\nsteps:\n  - visit: /\n    label: go\nexpect:\n${rules}`);
  return evaluate([{ type: 'run', id: runId, networkMode: 'stub', gtmOverride: override }, ...records] as never, scenario);
}

const REPORTS = [
  report({ event: 'gtm.js', tags: [tag('11', 'GA4 - Config'), tag('13', null, 'failure'), tag('14', null)] }),
  report({ event: 'purchase', t: 300, tags: [tag('11', 'GA4 - Config'), tag('77', 'GA4 - Workspace Only')] }),
];

test('an id rule passes on a matching entry and cites the report', () => {
  const [r] = run('  must:\n    - { tag: { id: 77 } }\n', REPORTS);
  expect(r).toMatchObject({ pass: true, evidence: [REPORTS[1]!.id] });
});

test('an id rule that matches nothing fails, and mustNot passes', () => {
  expect(run('  must:\n    - { tag: { id: "45" } }\n', REPORTS)[0]!.pass).toBe(false);
  expect(run('  mustNot:\n    - { tag: { id: "45" } }\n', REPORTS)[0]!.pass).toBe(true);
});

test('count counts entries over reports', () => {
  expect(run('  must:\n    - { tag: { id: "11" }, count: 2 }\n', REPORTS)[0]!.pass).toBe(true);
  expect(run('  must:\n    - { tag: { id: "11" }, count: 3 }\n', REPORTS)[0]!.pass).toBe(false);
});

test('event narrows to the reports of that dataLayer event', () => {
  expect(run('  must:\n    - { tag: { id: "77", event: gtm.js } }\n', REPORTS)[0]!.pass).toBe(false);
  expect(run('  must:\n    - { tag: { id: "77", event: "pur*" } }\n', REPORTS)[0]!.pass).toBe(true);
});

test('status defaults to any and a list narrows it', () => {
  expect(run('  mustNot:\n    - { tag: { id: "13" } }\n', REPORTS)[0]!.pass).toBe(false);
  expect(run('  mustNot:\n    - { tag: { id: "13", status: success } }\n', REPORTS)[0]!.pass).toBe(true);
  expect(run('  must:\n    - { tag: { id: "13", status: [failure, timeout] } }\n', REPORTS)[0]!.pass).toBe(true);
});

test('container and side narrow the reports, and no report there is noTagReports', () => {
  expect(run('  must:\n    - { tag: { id: "11", container: GTM-PWNOVER } }\n', REPORTS)[0]).toMatchObject({ pass: false, note: 'noTagReports' });
  expect(run('  mustNot:\n    - { tag: { id: "11", side: server } }\n', REPORTS)[0]).toMatchObject({ pass: false, note: 'noTagReports' });
  expect(run('  must:\n    - { tag: { id: "11", side: web } }\n', REPORTS)[0]!.pass).toBe(true);
});

test('a run with no reports at all cannot evaluate a tag rule, in must and mustNot', () => {
  for (const kind of ['must', 'mustNot']) expect(run(`  ${kind}:\n    - { tag: { id: "11" } }\n`, [])[0]).toMatchObject({ pass: false, note: 'noTagReports' });
});

test('after starts at the step end and from at its start', () => {
  const step = { type: 'step', id: newId('step'), runId, index: 0, kind: 'visit', label: 'go', startedAt: 200, endedAt: 250, status: 'ok' };
  expect(run('  must:\n    - { tag: { id: "11" }, after: go }\n', [step, ...REPORTS])[0]).toMatchObject({ pass: true, evidence: [REPORTS[1]!.id] });
  expect(run('  must:\n    - { tag: { id: "13" }, after: go }\n', [step, ...REPORTS])[0]!.pass).toBe(false);
  expect(run('  must:\n    - { tag: { id: "13" }, from: go }\n', [{ ...step, startedAt: 50 }, ...REPORTS])[0]!.pass).toBe(true);
});

test('a name pattern matches the report name, and expectedTags fills a missing one', () => {
  expect(run('  must:\n    - { tag: { name: "GA4 - *" } }\n', REPORTS)[0]!.pass).toBe(true);
  const filled = run('  mustNot:\n    - { tag: { name: "Meta *" } }\n', REPORTS, OVERRIDE)[0]!;
  expect(filled).toMatchObject({ pass: false, evidence: [REPORTS[0]!.id] });
  expect(filled.message).toContain('13 Meta - PageView');
});

test('a name pattern on a tag with no name anywhere cannot be evaluated when the verdict depends on it', () => {
  const must = run('  must:\n    - { tag: { name: "X *" } }\n', REPORTS, OVERRIDE)[0]!;
  expect(must).toMatchObject({ pass: false, note: 'tagNameUnknown', evidence: [REPORTS[0]!.id] });
  expect(run('  mustNot:\n    - { tag: { name: "X *" } }\n', REPORTS, OVERRIDE)[0]).toMatchObject({ pass: false, note: 'tagNameUnknown' });
  expect(run('  must:\n    - { tag: { name: "GA4 - Config" } }\n', REPORTS, OVERRIDE)[0]).toMatchObject({ pass: true });
  expect(run('  must:\n    - { tag: { name: "X *" } }\n', REPORTS)[0]).toMatchObject({ note: 'tagNameUnknown' });
});

test('names in a message are masked and the email never appears', () => {
  const records = [report({ tags: [tag('88', 'Lead - pw-fixture@example.com')] })];
  const [r] = run('  mustNot:\n    - { tag: { id: "88" } }\n', records);
  expect(r!.pass).toBe(false);
  expect(r!.message).toContain('88 (other)');
  expect(JSON.stringify(r)).not.toContain('pw-fixture');
});

test('summarizeTags lists fired tags with names, statuses and the expected tags that did not fire', () => {
  const summary = summarizeTags(REPORTS, { container: 'GTM-PWTEST1', tags: OVERRIDE.expectedTags })!;
  expect(summary['GTM-PWTEST1']).toEqual({
    reports: 2,
    fired: [
      { id: '11', name: 'GA4 - Config', nameFrom: 'report', count: 2, statuses: { success: 2 } },
      { id: '13', name: 'Meta - PageView', nameFrom: 'expectedTags', count: 1, statuses: { failure: 1 } },
      { id: '14', name: null, nameFrom: null, count: 1, statuses: { success: 1 } },
      { id: '77', name: 'GA4 - Workspace Only', nameFrom: 'report', count: 1, statuses: { success: 1 } },
    ],
    notFired: [{ id: '45', name: 'GA4 - Purchase' }],
  });
});

test('summarizeTags: a container with no report has one shape, and notFired is null without a comparison', () => {
  expect(summarizeTags([], { container: 'GTM-PWTEST1', tags: [] })).toEqual({ 'GTM-PWTEST1': { reports: 0, hint: 'tagreeve template web --json' } });
  expect(summarizeTags([], undefined)).toBeUndefined();
  const other = summarizeTags(REPORTS, { container: 'GTM-PWNOVER', tags: [{ id: '1', name: null }] })!;
  expect(other['GTM-PWTEST1']).toMatchObject({ notFired: null });
  expect(other['GTM-PWNOVER']).toEqual({ reports: 0, hint: 'tagreeve template web --json' });
  expect((summarizeTags(REPORTS, { container: 'GTM-PWTEST1', tags: [] })!['GTM-PWTEST1'] as { notFired: unknown }).notFired).toBeNull();
});

test('summarizeTags masks an email name and a strange status, and keeps [redacted]', () => {
  const records = [report({ tags: [tag('88', 'Lead - pw-fixture@example.com', 'pw-fixture@example.com'), tag('89', '[redacted]')] })];
  const out = JSON.stringify(summarizeTags(records, undefined));
  expect(out).not.toContain('pw-fixture');
  expect(out).toContain('"name":"(other)"');
  expect(out).toContain('"name":"[redacted]"');
});

test('only web reports count for notFired', () => {
  const server = report({ side: 'server', tags: [tag('45', 'GA4 - Purchase')] });
  const summary = summarizeTags([...REPORTS, server], { container: 'GTM-PWTEST1', tags: OVERRIDE.expectedTags })!;
  expect((summary['GTM-PWTEST1'] as { notFired: unknown }).notFired).toEqual([{ id: '45', name: 'GA4 - Purchase' }]);
});
