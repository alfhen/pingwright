import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiffResult } from '@pingwright/expect';
import { expect, test } from 'vitest';
import { parseCli, UsageError } from './args.ts';
import { formatDiff } from './diff.ts';
import { main } from './main.ts';

const empty: DiffResult = { warnings: [], added: [], removed: [], changed: [], countMismatches: [], flags: [] };
const key = (epoch: string, vendor: string, event: string) => ({ epoch, vendor, event });

test('parses diff with its options', () => {
  expect(parseCli(['diff', 'a.jsonl', 'b.jsonl', '--by-page', '--json'])).toEqual({ command: 'diff', a: 'a.jsonl', b: 'b.jsonl', byPage: true, json: true });
  expect(parseCli(['diff', 'a', 'b'])).toMatchObject({ byPage: false, json: false });
  expect(() => parseCli(['diff', 'a'])).toThrow(UsageError);
});

test('groups by epoch, then vendor, then event', () => {
  const text = formatDiff(
    {
      ...empty,
      added: [{ key: key('undecided', 'ga4', 'workspace_only'), hitId: 'hit_2', t: 1, step: 'consent-1' }],
      removed: [{ key: key('undecided', 'meta', 'AddToCart'), hitId: 'hit_9', t: 2, step: '' }],
      changed: [
        {
          key: key('undecided', 'ga4', 'page_view'),
          a: { hitId: 'hit_1', t: 0, step: 'start' },
          b: { hitId: 'hit_3', t: 0, step: 'consent-1' },
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
    id: 'run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
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
