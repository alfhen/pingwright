import { expect, test } from 'vitest';
import { run, site } from './cli-helpers.ts';

const theme = (name: string) => ['--var', `theme=${name}`];

test('a role locator passes on the radio theme', async () => {
  const r = await run('tiles-role', theme('radio'));
  expect(r.code).toBe(0);
}, 90_000);

test('a wrong role times out and the error lists the controls on the page', async () => {
  const r = await run('tiles-role', theme('button'));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('Controls on the page:');
  expect(r.stderr).toContain('button "White (01)"');
  expect(r.stderr).toContain('button "Black (02)"');
}, 90_000);

test('an any list passes on both themes and records which selector matched', async () => {
  for (const [name, index] of [['radio', 0], ['button', 1]] as const) {
    const r = await run('tiles-any', theme(name));
    expect(r.code).toBe(0);
    expect(r.records!.steps.find((s) => s.label === 'pick')!.locator).toBe(index);
    expect(r.records!.steps.find((s) => s.label === 'start')!.locator).toBeUndefined();
  }
}, 90_000);

test('select chooses by value and passes', async () => {
  const r = await run('select-country');
  expect(r.code).toBe(0);
}, 90_000);

test('select fails when the page resets the value', async () => {
  const r = await run('select-broken');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('value not applied (still: Choose)');
}, 90_000);

test('a card select is refused on a host that is not loopback and allowed on localhost', async () => {
  const hosted = new URL(site.url);
  hosted.hostname = 'shop.localhost';
  const refused = await run('select-card', ['--site', hosted.origin]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain('Payments and log-ins must be handoff steps');
  const local = await run('select-card');
  expect(local.code).toBe(0);
}, 90_000);

test('a selected country joins the identity, so its hash matches and is not possible real data', async () => {
  const r = await run('select-hash');
  expect(r.code).toBe(0);
  expect(r.records!.run.identity!.extra).toEqual(expect.arrayContaining(['DE', 'Germany']));
  expect(r.records!.flags.some((f) => f.kind === 'possibleRealData')).toBe(false);
}, 90_000);
