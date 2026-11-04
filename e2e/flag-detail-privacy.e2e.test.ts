import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

const SECRETS = ['pw-flag.user', 'pw-flag.user%40example.test', 'pw-flag.user@example.test', '0123456789abcdef0123456789abcdef', 'pwfake-cookie-value-0001'];

test('flag detail in the summary shows query names only, and the record keeps the values', async () => {
  const json = await run('flag-detail-privacy');
  const records = json.records!;
  const text = await runText('flag-detail-privacy');
  const path = /^Record: (.+)$/m.exec(text.stdout)![1]!;
  const recordText = await readFile(path, 'utf8');

  const kinds = new Set(records.flags.map((f) => f.kind));
  expect(kinds).toContain('unknownDestination');
  expect(kinds).toContain('sandboxPageUrl');
  expect(records.flags.some((f) => f.detail.includes('pw-flag.user'))).toBe(true);
  for (const value of SECRETS.slice(1)) expect(recordText).toContain(value);

  const summary = JSON.parse(json.stdout) as { flags: { kind: string; detail: string }[]; results: { message: string }[] };
  const unknown = summary.flags.find((f) => f.kind === 'unknownDestination')!;
  expect(unknown.detail).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/unknown-pixel\?email&h&sid$/);
  const sandboxDetails = summary.flags.filter((f) => f.kind === 'sandboxPageUrl').map((f) => f.detail);
  expect(sandboxDetails.find((d) => d.includes(' received http'))).toMatch(/\/sandbox\/modern\/\?email&h&sid as the page$/);
  // The GA4 hit takes its page from a relative `dl` that an evaluate step sends, so this flag holds a relative URL.
  expect(sandboxDetails).toContain('ga4 received /web-pixels@0.0.0-fixture/sandbox/modern/account/(other)?email&sid as the page');
  expect(records.flags.some((f) => f.kind === 'sandboxPageUrl' && f.detail.includes('pw-flag.user@example.test'))).toBe(true);

  for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    for (const value of SECRETS) expect(output).not.toContain(value);
  }
}, 180_000);
