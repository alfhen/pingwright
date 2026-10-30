import { expect, test } from 'vitest';
import { ga4, run, SANDBOX } from './cli-helpers.ts';

test('checkout after accept: purchase carries user_id with consent granted', async () => {
  const r = await run('checkout');
  expect(r.failed).toEqual([SANDBOX]);
  const purchase = ga4(r.records!.hits, 'purchase');
  expect(purchase.length).toBeGreaterThan(0);
  expect(purchase.every((h) => h.consent.analytics === 'granted' && h.ids.user_id)).toBe(true);
  expect(r.records!.hits.some((h) => h.vendor === 'meta' && h.event === 'Purchase')).toBe(true);
  expect(r.records!.hits.some((h) => h.vendor === 'google-ads')).toBe(true);
  expect(r.records!.run.identity).toMatchObject({ seed: 1 });
}, 120_000);

test('checkout after reject: the user_id mustNot rule fails and the run exits 1', async () => {
  const r = await run('checkout-reject');
  expect(r.code).toBe(1);
  const purchase = ga4(r.records!.hits, 'purchase');
  expect(purchase.length).toBeGreaterThan(0);
  expect(purchase.every((h) => h.consent.analytics === 'denied' && h.ids.user_id)).toBe(true);
  const rule = r.records!.results.find((x) => x.expectation.startsWith('mustNot:'))!;
  expect(rule.pass).toBe(false);
  expect(rule.evidence).toEqual(expect.arrayContaining(purchase.map((h) => h.id)));
}, 120_000);

test('checkout pattern: Meta Purchase carries the hashed email and hashesMatch passes', async () => {
  const r = await run('checkout-pattern');
  expect(r.failed).toEqual([SANDBOX]);
  const purchase = r.records!.hits.filter((h) => h.vendor === 'meta' && h.event === 'Purchase');
  expect(purchase.some((h) => h.params.hashedEmail)).toBe(true);
}, 120_000);

test('checkout sgtm pattern: hashesMatch passes on the server-container hit, and a literal city is not real data', async () => {
  const r = await run('checkout-sgtm');
  expect(r.failed).toEqual([SANDBOX]);
  const purchase = r.records!.hits.filter((h) => h.vendor === 'sgtm' && h.event === 'purchase');
  expect(purchase.some((h) => h.params['user_data.email_address'] && h.params['user_data.city'])).toBe(true);
  expect(r.records!.run.identity).toMatchObject({ phone: '+46701740620', extra: expect.arrayContaining(['Berlin']) });
  const real = r.records!.results.find((x) => x.expectation === 'builtin: possibleRealData')!;
  expect(real.pass).toBe(true);
}, 120_000);

test('checkout sgtm pattern with a wrong email fails identity.hashesMatch on the sgtm hit', async () => {
  const r = await run('checkout-sgtm-wrong-hash');
  expect(r.code).toBe(1);
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(rule.pass).toBe(false);
  expect(rule.message).toContain('do not match the run identity');
}, 120_000);

const dataTagPurchase = (r: Awaited<ReturnType<typeof run>>) => r.records!.hits.filter((h) => h.vendor === 'sgtm' && h.event === 'purchase');

test('sgtm-data-tag-top: an empty phone and hashed postal code and country pass hashesMatch', async () => {
  const r = await run('sgtm-data-tag-top');
  expect(r.failed).toEqual([SANDBOX]);
  const hit = dataTagPurchase(r).find((h) => h.params['user_data.email_address']);
  expect(hit).toBeDefined();
  expect(hit!.params['user_data.phone_number'] ?? '').toBe('');
  expect(hit!.params['user_data.postal_code']).toMatch(/^[0-9a-f]{64}$/);
  expect(hit!.params['user_data.country']).toMatch(/^[0-9a-f]{64}$/);
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(rule.pass).toBe(true);
}, 120_000);

test.each([
  ['postal', 'postal code', 'user_data.postal_code'],
  ['country', 'country', 'user_data.country'],
])('a Data Tag purchase with a wrong hashed %s fails identity.hashesMatch and names only that field', async (field, label, param) => {
  const r = await run(`sgtm-data-tag-wrong-${field}`);
  expect(r.code).toBe(1);
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(rule.pass).toBe(false);
  expect(rule.message).toContain(`the hashed ${label} values it carried do not match the run identity. Not matching: ${param}. Matching: `);
  const matching = /Matching: (.*)\.$/.exec(rule.message ?? '')![1]!;
  expect(matching).toContain('email');
  expect(matching).toContain('first name');
  expect(matching).toContain('last name');
  expect(matching).not.toContain(label);
  expect(rule.message).not.toMatch(/phone/);
}, 120_000);

test('sgtm-data-tag-list: the first address object supplies street and city', async () => {
  const r = await run('sgtm-data-tag-list');
  expect(r.failed).toEqual([SANDBOX]);
  const hit = dataTagPurchase(r).find((h) => h.params['user_data.email_address']);
  expect(hit).toBeDefined();
  expect(hit!.params['user_data.first_name']).toBeTruthy();
  expect(hit!.params['user_data.street']).toMatch(/^[0-9a-f]{64}$/);
  expect(hit!.params['user_data.city']).toMatch(/^[0-9a-f]{64}$/);
}, 120_000);

test('a Data Tag purchase with a wrong email hash fails identity.hashesMatch', async () => {
  const r = await run('sgtm-data-tag-wrong-hash');
  expect(r.code).toBe(1);
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(rule.pass).toBe(false);
  expect(rule.message).toContain('the hashed email values it carried do not match the run identity');
}, 120_000);

test('checkout pattern with a wrong email fails identity.hashesMatch', async () => {
  const r = await run('checkout-pattern-wrong-hash');
  expect(r.code).toBe(1);
  const rule = r.records!.results.find((x) => x.expectation.includes('hashesMatch'))!;
  expect(rule.pass).toBe(false);
  expect(rule.message).toContain('do not match the run identity');
}, 120_000);
