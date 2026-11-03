/** One part of the sample summary and the exact text of each line it covers. */
export interface Annotation {
  key: string;
  title: string;
  body: string;
  lines: string[];
}

/**
 * The explanations for the ```text annotated fence in docs/guide/reading-results.md. Every line of the
 * fence must be listed here exactly once, so a changed sample fails the build instead of pointing at the
 * wrong line.
 */
export const ANNOT: Annotation[] = [
  {
    key: 'hits',
    title: 'Hits',
    body: 'Each vendor and event, and how many times it was sent.',
    lines: ['Hits', '  ga4: page_view x3', '  meta: PageView x1', '  google-ads: page_view x1'],
  },
  {
    key: 'sgtm',
    title: 'sgtm',
    body: 'A server-side GTM container. (no event) means the hit had no event name.',
    lines: ['  sgtm: (no event) x1'],
  },
  {
    key: 'epochs',
    title: 'Consent epochs',
    body: 'The periods of one consent state in the run. This run never answered the banner, so it ends undecided.',
    lines: ['Consent epochs', '  undecided (to end)'],
  },
  {
    key: 'flags',
    title: 'Flags',
    body: 'Things worth a look. Some fail the run, such as unknownDestination. Others only inform.',
    lines: [
      'Flags',
      '  unknownDestination: 127.0.0.1:57305 x1 (/unknown-pixel)',
      '  sandboxPageUrl: ga4 x1 (/web-pixels@0.0.0-fixture/sandbox/modern/)',
    ],
  },
  {
    key: 'exp',
    title: 'Expectations',
    body: 'Your rules and the built-in checks, each with PASS, FAIL or WARN.',
    lines: [
      'Expectations',
      '  FAIL mustNot: {"vendor":["meta","google-ads"],"before":"consent"}',
      '       Expected no matching hits before consent, found 2 matching hits (2 before narrowing).',
      '  FAIL builtin: unknownDestination',
      '       Expected no requests to unknown destinations, found 1: 127.0.0.1 x1.',
      '  FAIL builtin: sandboxPageUrl',
      '       Expected no hit to carry a sandbox URL as its page, found 1: http://localhost:57308/web-pixels@0.0.0-fixture/sandbox/modern/.',
      '  PASS builtin: deniedIdentifiers',
      '  PASS builtin: earlyIdentifiers',
      '  PASS builtin: possibleRealData',
    ],
  },
  {
    key: 'ev',
    title: 'evidence',
    body: 'The IDs of the records behind the failure. grep the record file for one to see the whole hit.',
    lines: [
      '       evidence: hit_01M66G9M2S992B5DF1MZ15ZQ08, hit_01M66G9M2T97WBWV5AA85VFM3W',
      '       evidence: flg_01M66G9M2VCB4KHQ2ZD3ZQ9J4R, req_01M66G9DWR5CH6SQB4MF2XJWHX',
      '       evidence: hit_01M66G9M2S992B5DF1MZ15ZQ07',
    ],
  },
  {
    key: 'res',
    title: 'Result',
    body: '3 of 6 checks failed. The exit code is 1.',
    lines: ['Result: fail (3 of 6)'],
  },
  {
    key: 'rec',
    title: 'Record',
    body: 'One JSON object per line: run, step, request, hit, consentEpoch, flag, result…',
    lines: ['Record: runs/run_01M66G9DA0714WFS5QHQM5A0NX.jsonl'],
  },
];
