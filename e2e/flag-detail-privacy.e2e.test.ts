import { readFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { run, runText } from './cli-helpers.ts';

const SECRETS = ['pw-flag.user', 'pw-flag.user%40example.test', '0123456789abcdef0123456789abcdef', 'pwfake-cookie-value-0001'];

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
  expect(summary.flags.find((f) => f.kind === 'sandboxPageUrl')!.detail).toMatch(/\/sandbox\/modern\/\?email&h&sid as the page$/);

  for (const output of [json.stdout, json.stderr, text.stdout, text.stderr]) {
    for (const value of SECRETS) expect(output).not.toContain(value);
  }
}, 180_000);
