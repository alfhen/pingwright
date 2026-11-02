import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { SuiteArgs } from './args.ts';
import type { RunOutcome, RunSpec } from './run.ts';
import { suiteCommand } from './suite.ts';

const VALID = 'start: /\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n';
const PAYMENT = 'start: /\nsteps:\n  - payment: { provider: fixture, card: "4242424242424242" }\nexpect:\n  must: []\n  mustNot: []\n';
const pass: RunOutcome = { code: 0, summary: { ok: true, pass: true } as RunOutcome['summary'] };

async function workDir(files: Record<string, string>): Promise<{ dir: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pw-suite-pay-'));
  const dir = join(root, 'scenarios');
  await mkdir(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { dir, out: join(root, 'runs') };
}

function args(dir: string, out: string, extra: Partial<SuiteArgs> = {}): SuiteArgs {
  return {
    command: 'suite',
    dir,
    site: 'http://localhost:3000',
    variants: [{ name: 'published' }],
    network: undefined,
    out,
    seed: undefined,
    withHandoff: false,
    withTestPayment: false,
    autoconsentRules: [],
    trackerList: undefined,
    vars: {},
    json: false,
    ...extra,
  };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (t: string) => void stdout.push(t), stderr: (t: string) => void stderr.push(t) }, out: () => stdout.join(''), err: () => stderr.join('') };
}

function recorder() {
  const specs: RunSpec[] = [];
  return {
    specs,
    run: async (spec: RunSpec) => {
      specs.push(spec);
      return pass;
    },
  };
}

async function withAllowlist<T>(hosts: string[], body: () => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pw-suite-xdg-'));
  await mkdir(join(root, 'pingwright'));
  await writeFile(join(root, 'pingwright', 'test-payment-hosts.json'), JSON.stringify(hosts), { mode: 0o600 });
  const before = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
  }
}

test.each([{}, { withTestPayment: true }, { allowTestPayment: 'localhost' }])('payment scenarios are skipped with %j', async (extra) => {
  const { dir, out } = await workDir({ 'a-card.yml': PAYMENT, 'b.yml': VALID });
  const fake = recorder();
  const c = capture();
  expect(await withAllowlist(['localhost'], () => suiteCommand(args(dir, out, extra), c.io, fake))).toBe(0);
  expect(fake.specs.map((s) => s.scenarioName)).toEqual(['b']);
  expect(c.out()).toMatch(/a-card\s+SKIPPED/);
});

test('with both flags and a listed host the payment scenario runs with the test payment host', async () => {
  const { dir, out } = await workDir({ 'a-card.yml': PAYMENT, 'b.yml': VALID });
  const fake = recorder();
  const a = args(dir, out, { withTestPayment: true, allowTestPayment: 'localhost' });
  expect(await withAllowlist(['localhost'], () => suiteCommand(a, capture().io, fake))).toBe(0);
  expect(fake.specs.map((s) => [s.scenarioName, s.testPayment])).toEqual([
    ['a-card', { host: 'localhost' }],
    ['b', undefined],
  ]);
});

test('a failed gate with --with-test-payment exits 2 before any run', async () => {
  const { dir, out } = await workDir({ 'a-card.yml': PAYMENT, 'b.yml': VALID });
  const fake = recorder();
  const c = capture();
  const a = args(dir, out, { withTestPayment: true, allowTestPayment: '127.0.0.1' });
  expect(await withAllowlist(['localhost'], () => suiteCommand(a, c.io, fake))).toBe(2);
  expect(fake.specs).toEqual([]);
  expect(c.err()).toContain('must name the --site host');
});
