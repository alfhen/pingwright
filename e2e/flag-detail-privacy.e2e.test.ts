import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

const SECRETS = ['pw-flag.user', 'pw-flag.user%40example.test', 'pw-flag.user@example.test', '0123456789abcdef0123456789abcdef', '34b6319597f5649a26a95fff3b8cbd56ddb809f5b88647df59523a8d5f51979c', 'pwfake-cookie-value-0001'];

test('flag detail in the summary shows query names only, and the record keeps the values', async () => {
  const json = await run('flag-detail-privacy');
  const records = json.records!;
  const text = await runText('flag-detail-privacy');
  const path = /^Record: (.+)$/m.exec(text.stdout)![1]!;
  const recordText = await readFile(path, 'utf8');

  const kinds = new Set(records.flags.map((f) => f.kind));
  expect(kinds).toContain('unknownDestination');
  expect(kinds).toContain('sandboxPageUrl');
  const bypass = records.flags.filter((f) => f.kind === 'stubBypass');
  expect(bypass.length).toBeGreaterThan(0);
  for (const value of [SECRETS[1]!, SECRETS[4]!, SECRETS[5]!]) expect(bypass.some((f) => f.detail.includes(value))).toBe(true);
  expect(records.flags.some((f) => f.detail.includes('pw-flag.user'))).toBe(true);
  for (const value of SECRETS.slice(1)) expect(recordText).toContain(value);

  const summary = JSON.parse(json.stdout) as { flags: { kind: string; detail: string }[]; results: { message: string }[] };
  const unknown = summary.flags.find((f) => f.kind === 'unknownDestination')!;
  expect(unknown.detail).toMatch(/^GET http:\/\/127\.0\.0\.1:\d+\/unknown-pixel\?email&h&sid$/);
  const sandboxDetails = summary.flags.filter((f) => f.kind === 'sandboxPageUrl').map((f) => f.detail);
  expect(sandboxDetails.find((d) => d.includes(' received http'))).toMatch(/\/sandbox\/modern\/\?email&h&sid as the page$/);
  // The GA4 hit takes its page from a relative `dl` that an evaluate step sends, so this flag holds a relative URL.
  expect(sandboxDetails).toContain('ga4 received /web-pixels@0.0.0-fixture/sandbox/modern/account/(other)?email&sid as the page');
  const bypassSummary = summary.flags.find((f) => f.kind === 'stubBypass')!;
  expect(bypassSummary.detail).toMatch(/^It followed a redirect, so it was not stubbed: http:\/\/localhost:\d+\/g\/collect\?v&tid&en&email&h&sid$/);
  expect(records.flags.some((f) => f.kind === 'sandboxPageUrl' && f.detail.includes('pw-flag.user@example.test'))).toBe(true);

  for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    for (const value of SECRETS) expect(output).not.toContain(value);
  }
}, 180_000);
