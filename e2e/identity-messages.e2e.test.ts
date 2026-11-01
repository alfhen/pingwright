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
