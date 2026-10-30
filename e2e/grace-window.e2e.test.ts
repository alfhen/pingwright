import { expect, test } from 'vitest';
import { DEFAULT_GRACE_MS } from '../packages/expect/src/index.ts';
import { run } from './cli-helpers.ts';

test('Run.graceWindowMs holds the scenario graceWindow', async () => {
  const r = await run('grace-window');
  expect(r.code).toBe(0);
  expect(r.records!.run.graceWindowMs).toBe(120);
}, 90_000);

test('Run.graceWindowMs holds the default without a graceWindow', async () => {
  const r = await run('grace-window-default');
  expect(r.code).toBe(0);
  expect(r.records!.run.graceWindowMs).toBe(DEFAULT_GRACE_MS);
}, 90_000);
