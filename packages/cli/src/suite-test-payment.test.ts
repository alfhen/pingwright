import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { parseScenario } from '@tagreeve/expect';
import type { SuiteArgs } from './args.ts';
import type { RunOutcome, RunSpec } from './run.ts';
import { suiteCommand } from './suite.ts';

let recordFailure = 'step "payment-1": test mode not detected';

vi.mock('@tagreeve/recorder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tagreeve/recorder')>()),
  recordScenario: async () => {
    throw new Error(recordFailure);
  },
}));

const { executeRun } = await import('./run.ts');

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
  await mkdir(join(root, 'tagreeve'));
  await writeFile(join(root, 'tagreeve', 'test-payment-hosts.json'), JSON.stringify(hosts), { mode: 0o600 });
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

test('executeRun adds the declaration hint after "test mode not detected"', async () => {
  const parsed = parseScenario(PAYMENT);
  const spec = (): RunSpec =>
    ({ parsed, scenarioName: 'a-card', network: 'stub', site: 'https://shop.example.com', out: '/nowhere', autoconsentRules: [], trackers: [], testPayment: { host: 'shop.example.com' } }) as unknown as RunSpec;
  const lines = async () => {
    const err: string[] = [];
    const outcome = await executeRun(spec(), { stdout: () => undefined, stderr: (t) => void err.push(t) });
    expect(outcome.code).toBe(2);
    return err.join('').split('\n');
  };
  const hint = (await lines()).find((l) => l.startsWith('Declare it in'));
  expect(hint).toContain('test-payment-hosts.json');
  expect(hint).toContain('{ "host": "shop.example.com", "testMode": "fixture" }');

  recordFailure = 'step "payment-1": test mode not detected (the page is not on the allowed test payment host)';
  expect((await lines()).some((l) => l.startsWith('Declare it in'))).toBe(false);
  recordFailure = 'step "payment-1": card frame not found (number)';
  expect((await lines()).some((l) => l.startsWith('Declare it in'))).toBe(false);
});

test('a declared host reaches the run as a declared provider', async () => {
  const { dir, out } = await workDir({ 'a-card.yml': PAYMENT });
  const fake = recorder();
  const a = args(dir, out, { withTestPayment: true, allowTestPayment: 'localhost' });
  const root = await mkdtemp(join(tmpdir(), 'pw-suite-xdg-'));
  await mkdir(join(root, 'tagreeve'));
  await writeFile(join(root, 'tagreeve', 'test-payment-hosts.json'), JSON.stringify(['localhost', { host: 'localhost', testMode: 'fixture' }]), { mode: 0o600 });
  const before = process.env.XDG_CONFIG_HOME;
  const seam = process.env.TAGREEVE_TEST_LOOPBACK_IS_HOSTED;
  process.env.XDG_CONFIG_HOME = root;
  process.env.TAGREEVE_TEST_LOOPBACK_IS_HOSTED = '1';
  try {
    expect(await suiteCommand(a, capture().io, fake)).toBe(0);
  } finally {
    if (before === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = before;
    if (seam === undefined) delete process.env.TAGREEVE_TEST_LOOPBACK_IS_HOSTED;
    else process.env.TAGREEVE_TEST_LOOPBACK_IS_HOSTED = seam;
  }
  expect(fake.specs.map((s) => s.testPayment)).toEqual([{ host: 'localhost', declaredProviders: ['fixture'] }]);
});
