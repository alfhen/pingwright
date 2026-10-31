import { expect, test } from 'vitest';
import type { ExpectationView, ReportModel } from './model.ts';
import { IDENTIFIER_LEAK } from './model.ts';
import { addFindings, emptyFindings, findingsSentence, runVerdict } from './verdict.ts';

const rule = (status: ExpectationView['status'], kind = 'mustNot'): ExpectationView => ({ status, kind, text: `${kind}: vendor: ga4`, note: undefined, evidence: [], evidenceCount: 0 });
const check = (status: ExpectationView['status'], name: string): ExpectationView => ({ ...rule(status, 'builtin'), text: `builtin: ${name}` });

function model(expectations: ExpectationView[], leaks: { vendor: string; label?: string }[] = []): ReportModel {
  return {
    header: { scenario: 's', variant: undefined, runId: 'r', startedAt: '2026-10-31T00:00:00.000Z', networkMode: 'stub', host: 'shop.example.com', pingwrightVersion: '0', schemaVersion: 2 },
    columns: [{ label: 'denied', index: 0 }],
    rows: leaks.map((l) => ({ vendor: l.vendor, hits: 1, segments: [{ mark: 'leak' as const, label: l.label ?? 'x', hits: 1 }] })),
    expectations,
    flags: [],
    fields: [],
  };
}

function sentence(models: ReportModel[], inRuns = false): string {
  const f = emptyFindings();
  for (const m of models) addFindings(f, m);
  return findingsSentence(f, inRuns);
}

test('a failing must and a failing mustNot are two rules', () => {
  expect(sentence([model([rule('FAIL', 'must'), rule('FAIL'), rule('PASS')])])).toBe('no leaks; 2 rules failed');
  expect(sentence([model([rule('FAIL')])])).toBe('no leaks; 1 rule failed');
});

test('built-in checks are named with the runs they failed in', () => {
  const runs = [1, 2, 3, 4].map(() => model([check('FAIL', 'sandboxPageUrl')]));
  expect(sentence(runs, true)).toBe('no leaks; built-in check sandboxPageUrl failed in 4 runs');
  expect(sentence(runs.slice(0, 1), true)).toBe('no leaks; built-in check sandboxPageUrl failed in 1 run');
});

test('a check that fails twice in one run counts one run', () => {
  expect(sentence([model([check('FAIL', 'sandboxPageUrl'), check('FAIL', 'sandboxPageUrl')])], true)).toBe('no leaks; built-in check sandboxPageUrl failed in 1 run');
});

test('rules and checks together', () => {
  const m = model([rule('FAIL'), check('FAIL', 'sandboxPageUrl')]);
  expect(sentence([m, m, m, m], true)).toBe('no leaks; 4 rules failed; built-in check sandboxPageUrl failed in 4 runs');
});

test('the single-run verdict names the check without a run count', () => {
  expect(runVerdict(model([rule('FAIL'), check('FAIL', 'sandboxPageUrl')]))).toBe('Verdict: no leaks; 1 rule failed; built-in check sandboxPageUrl failed.');
});

test('warnings split the same way', () => {
  expect(sentence([model([rule('WARN'), check('WARN', 'sandboxPageUrl')])], true)).toBe('no leaks; 1 rule warned; built-in check sandboxPageUrl warned in 1 run');
});

test('a cannot-evaluate result is reported separately from failed rules', () => {
  expect(sentence([model([rule('CANNOT EVALUATE'), check('CANNOT EVALUATE', 'deniedIdentifiers'), rule('FAIL')])])).toBe('1 rule failed; 2 expectations could not be checked');
});

test('one vendor sends, two vendors send, with plain names', () => {
  expect(sentence([model([], [{ vendor: 'ga4' }])])).toBe('Google Analytics 4 sends hits in the denied state');
  expect(sentence([model([], [{ vendor: 'sgtm' }, { vendor: 'ga4' }])])).toBe('Google Analytics 4 and server container send hits in the denied state');
});

test('an unknown vendor key prints as the key', () => {
  expect(sentence([model([], [{ vendor: 'acme-pixel' }])])).toBe('acme-pixel sends hits in the denied state');
});

test('deniedIdentifiers is named once, failed or warned', () => {
  const leaks = [
    { vendor: 'ga4', label: IDENTIFIER_LEAK },
    { vendor: 'meta', label: IDENTIFIER_LEAK },
  ];
  expect(sentence([model([check('FAIL', 'deniedIdentifiers')], leaks)], true)).toBe('identifiers go out to Google Analytics 4 and Meta in the denied state');
  expect(sentence([model([check('WARN', 'deniedIdentifiers'), check('WARN', 'sandboxPageUrl')], leaks)], true)).toBe(
    'identifiers go out to Google Analytics 4 and Meta in the denied state; built-in check sandboxPageUrl warned in 1 run',
  );
});
