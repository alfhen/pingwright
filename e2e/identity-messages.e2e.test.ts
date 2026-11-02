import { expect, test } from 'vitest';
import { run } from './cli-helpers.ts';

const HEX = /[0-9a-f]{64}/;

test('possibleRealData names the hit parameter that carries a foreign hash, and never the value', async () => {
  const r = await run('identity-messages');
  const flag = r.records!.flags.find((f) => f.kind === 'possibleRealData');
  expect(flag?.detail).toMatch(/carries 1 hash value\(s\) that are not from the run identity, in user_data\.postal_code$/);
  const builtin = r.records!.results.find((x) => x.expectation === 'builtin: possibleRealData');
  expect(builtin?.pass).toBe(false);
  expect(builtin?.message).toContain('in user_data.postal_code');
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'));
  expect(rule?.message).toContain('Not matching: user_data.postal_code');
  const messages = [flag?.detail, builtin?.message, rule?.message].join('\n');
  expect(messages).not.toMatch(HEX);
  expect(r.stdout + r.stderr).not.toMatch(HEX);
}, 120_000);

test('possibleRealData skips a compressed beacon body whose bytes spell an email, and still fails a foreign value', async () => {
  const compressed = await run('identity-compressed-beacon');
  const beacon = compressed.records!.requests.find((q) => q.url.startsWith('https://replay.tagreeve.invalid/collect'));
  expect(beacon?.postData).toContain('visitor@other-person.example');
  expect(compressed.records!.flags.filter((f) => f.kind === 'possibleRealData')).toHaveLength(0);
  expect(compressed.failed).not.toContain('builtin: possibleRealData');
  const foreign = await run('identity-messages');
  expect(foreign.failed).toContain('builtin: possibleRealData');
}, 120_000);

test('possibleRealData names the JSON path and the multipart field, and never the value', async () => {
  const r = await run('identity-json-body');
  const posts = r.records!.requests.filter((q) => q.url.startsWith('https://replay.tagreeve.invalid/collect'));
  expect(posts.some((q) => q.postData?.includes('"customerHashed":{"country":"959a45d4'))).toBe(true);
  expect(posts.some((q) => q.postData?.includes('visitor@other-person.example'))).toBe(true);
  const details = r.records!.flags.filter((f) => f.kind === 'possibleRealData').map((f) => f.detail);
  expect(details.some((d) => /carries 1 hash value\(s\) .*, in customerHashed\.country$/.test(d))).toBe(true);
  expect(details.some((d) => /carries 1 email value\(s\) .*, in contact$/.test(d))).toBe(true);
  expect(details.join('\n')).not.toContain('in the body');
  const output = details.join('\n') + r.stdout + r.stderr;
  expect(output).not.toMatch(HEX);
  expect(output).not.toContain('visitor@other-person.example');
}, 120_000);
