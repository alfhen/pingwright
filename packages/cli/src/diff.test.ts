import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffResult } from '@pingwright/expect';
import { describe, expect, test } from 'vitest';
import { parseCli, UsageError } from './args.ts';
import { flagChangeLabel, formatDiff } from './diff.ts';
import { main } from './main.ts';

const empty: DiffResult = { warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags: [] };
const key = (epoch: string, vendor: string, event: string) => ({ epoch, vendor, event });

test('parses diff with its options', () => {
  expect(parseCli(['diff', 'a.jsonl', 'b.jsonl', '--by-page', '--json'])).toEqual({ command: 'diff', a: 'a.jsonl', b: 'b.jsonl', byPage: true, allFlags: false, json: true });
  expect(parseCli(['diff', 'a', 'b'])).toMatchObject({ byPage: false, allFlags: false, json: false });
  expect(parseCli(['diff', 'a', 'b', '--all-flags'])).toMatchObject({ allFlags: true });
  expect(() => parseCli(['diff', 'a'])).toThrow(UsageError);
});

test('groups by epoch, then vendor, then event', () => {
  const text = formatDiff(
    {
      ...empty,
      added: [{ key: key('undecided', 'ga4', 'workspace_only'), hitId: 'hit_2', t: 1, step: 'consent-1', page: null }],
      removed: [{ key: key('undecided', 'meta', 'AddToCart'), hitId: 'hit_9', t: 2, step: '', page: null }],
      changed: [
        {
          key: key('undecided', 'ga4', 'page_view'),
          a: { hitId: 'hit_1', t: 0, step: 'start', page: null },
          b: { hitId: 'hit_3', t: 0, step: 'consent-1', page: null },
          consent: [{ field: 'gcs', a: 'G100', b: 'G111' }],
          ids: [],
        },
      ],
    },
    'a.jsonl',
    'b.jsonl',
  );
  expect(text).toBe(
    [
      'Diff a.jsonl -> b.jsonl',
      '',
      'Epoch undecided',
      '  ga4',
      '    page_view',
      '      changed, step "start" -> "consent-1": gcs G100 -> G111 (hit_1 -> hit_3)',
      '    workspace_only',
      '      added (step "consent-1"): hit_2',
      '  meta',
      '    AddToCart',
      '      removed: hit_9',
      '',
    ].join('\n'),
  );
});

test('reports no differences', () => {
  expect(formatDiff(empty, 'a', 'b')).toContain('No differences.');
});

test('a missing file and an invalid file both exit 2 with a message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-diff-'));
  const bad = join(dir, 'bad.jsonl');
  await writeFile(bad, '{"type":"request"}\n');
  const err: string[] = [];
  const io = { stdout: () => {}, stderr: (t: string) => void err.push(t) };
  expect(await main(['diff', join(dir, 'nope.jsonl'), bad], io)).toBe(2);
  expect(err.join('')).toContain('nope.jsonl');
  err.length = 0;
  expect(await main(['diff', bad, bad], io)).toBe(2);
  expect(err.join('')).toContain('first record must be a run');
});

test('warns when an input file is cut off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pw-diff-'));
  const run = {
    type: 'run',
    id: 'run_0123456789ABCDEFGHJKMNPQRS',
    scenario: 'checkout',
    site: 'http://localhost:1234',
    startedAt: 1_800_000_000_000,
    pingwrightVersion: '0.0.0',
    browser: { name: 'chromium', version: '156.0.0.0' },
    networkMode: 'stub',
    gtmOverride: null,
    containerVersions: {},
    identity: null,
  };
  const cut = join(dir, 'cut.jsonl');
  await writeFile(cut, `${JSON.stringify(run)}\n{"type":"requ`);
  const out: string[] = [];
  const io = { stdout: (t: string) => void out.push(t), stderr: () => {} };
  expect(await main(['diff', cut, cut, '--json'], io)).toBe(0);
  expect(JSON.parse(out.join('')).warnings).toEqual([
    `${cut}: truncated at line 2; later records are missing from the diff`,
    `${cut}: truncated at line 2; later records are missing from the diff`,
  ]);
});

describe('changed lines', () => {
  const key = { epoch: 'undecided', vendor: 'ga4', event: 'purchase', page: '/checkout' };
  const change = { field: 'gcs', a: 'G100', b: 'G111' };
  const hit = (hitId: string, step: string, page: string | null) => ({ hitId, t: 0, step, page });
  const base = { warnings: [], added: [], removed: [], countMismatches: [], flags: [] };

  test('shows the step when it did not move', () => {
    const changed = [{ key, a: hit('hit_1', 'pay', 'https://shop.example.com/checkout'), b: hit('hit_2', 'pay', 'https://shop.example.com/checkout'), consent: [change], ids: [] }];
    expect(formatDiff({ ...base, changed }, 'a', 'b')).toContain('changed (step "pay", page /checkout): gcs G100 -> G111');
  });

  test('shows both raw pages when they differ from the key', () => {
    const a = 'https://shop.example.com/web-pixels@aaa/custom/web-pixel-1/sandbox/modern/checkout';
    const b = 'https://shop.example.com/web-pixels@bbb/custom/web-pixel-1/sandbox/modern/checkout';
    const changed = [{ key, a: hit('hit_1', 'pay', a), b: hit('hit_2', 'pay', b), consent: [change], ids: [] }];
    expect(formatDiff({ ...base, changed }, 'a', 'b')).toContain(`recorded as ${a} -> ${b}:`);
  });
});

describe('flag changes', () => {
  const flags = [
    { host: 'allowed.example.com', kind: 'unknownDestination', a: 17, b: 18, allowed: true },
    { host: 'other.example.com', kind: 'stubBypass', a: 0, b: 1, allowed: false },
  ];
  const result = { warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags };

  test('hides changes for allowed hosts by default', () => {
    const text = formatDiff(result, 'a', 'b');
    expect(text).not.toContain('allowed.example.com');
    expect(text).toContain('other.example.com');
    expect(text).toContain('1 flag count change for hosts allowed by allowUnknownDestination not shown (use --all-flags)');
  });

  test('shows them with allFlags', () => {
    const text = formatDiff(result, 'a', 'b', { allFlags: true });
    expect(text).toContain('unknownDestination allowed.example.com: 17 -> 18');
    expect(text).not.toContain('not shown');
  });

  test('a flag with no host prints no placeholder', () => {
    const noHost = [{ host: '', kind: 'unloadGap', a: 0, b: 1, allowed: false }];
    const text = formatDiff({ ...result, flags: noHost }, 'a', 'b');
    expect(text).toContain('  unloadGap: 0 -> 1\n');
    expect(text).not.toContain('no host');
  });

  test('a flag with a host names it', () => {
    expect(flagChangeLabel({ host: 'api.example.com', kind: 'unloadGap', a: 0, b: 1 })).toBe('unloadGap api.example.com: 0 -> 1');
  });
});
