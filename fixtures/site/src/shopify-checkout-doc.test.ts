import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseScenario } from '../../../packages/expect/src/index.ts';

const doc = readFileSync(new URL('../../../docs/shopify-checkout.md', import.meta.url), 'utf8');
const yamlBlock = /```yaml\n([\s\S]*?)```/.exec(doc)?.[1] ?? '';

test('the hosted checkout pattern parses', () => {
  const s = parseScenario(yamlBlock);
  expect(s.steps.map((x) => x.kind)).toEqual(['consent', 'addToCart', 'visit', 'fill', 'handoff', 'wait']);
  expect(s.steps.map((x) => x.label)).toEqual(expect.arrayContaining(['pay', 'thank-you']));
  expect(s.expect.must.some((r) => r.hashesMatch)).toBe(true);
});

test('the test payment variant parses, with a payment step in place of the handoff', () => {
  const block = /```yaml\n([\s\S]*?)```/g;
  block.exec(doc);
  const s = parseScenario(block.exec(doc)?.[1] ?? '');
  expect(s.steps.map((x) => x.kind)).toEqual(['consent', 'addToCart', 'visit', 'fill', 'payment', 'click', 'click', 'wait']);
  expect(s.steps.some((x) => x.kind === 'handoff')).toBe(false);
});

test('the fixture shop keeps the pattern flag and hashes the stored email', () => {
  const payment = readFileSync(new URL('../public/payment.html', import.meta.url), 'utf8');
  const thanks = readFileSync(new URL('../public/thank-you.html', import.meta.url), 'utf8');
  expect(payment).toContain('/thank-you?pattern=1');
  expect(thanks).toContain("'SHA-256'");
});
