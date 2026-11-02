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

const SEAM = 'TAGREEVE_TEST_LOOPBACK_IS_HOSTED';

function scenarioWith(...steps: [provider: string, card: string][]): string {
  const lines = steps.map(([provider, card]) => `  - payment: { provider: ${provider}, card: "${card}" }\n`).join('');
  return `start: /\nsteps:\n${lines}expect:\n  must: []\n  mustNot: []\n`;
}

const FIXTURE: [string, string] = ['fixture', '4242424242424242'];
const TEST: [string, string] = ['shopify-test', '4242424242424242'];
const BOGUS: [string, string] = ['shopify-bogus', '1'];

async function hintFor(steps: [string, string][], host: string, failure: string, seam = false): Promise<string | undefined> {
  const parsed = parseScenario(scenarioWith(...steps));
  const spec = { parsed, scenarioName: 'a-card', network: 'stub', site: `https://${host}`, out: '/nowhere', autoconsentRules: [], trackers: [], testPayment: { host } } as unknown as RunSpec;
  const before = process.env[SEAM];
  if (seam) process.env[SEAM] = '1';
  else delete process.env[SEAM];
  recordFailure = failure;
  try {
    const err: string[] = [];
    expect((await executeRun(spec, { stdout: () => undefined, stderr: (t) => void err.push(t) })).code).toBe(2);
    return err.join('').split('\n').find((l) => l.startsWith('Declare it in'));
  } finally {
    if (before === undefined) delete process.env[SEAM];
    else process.env[SEAM] = before;
  }
}

test('executeRun adds the declaration hint after "test mode not detected"', async () => {
  const hint = await hintFor([TEST], 'shop.example.com', 'step "payment-1": test mode not detected');
  expect(hint).toContain('test-payment-hosts.json');
  expect(hint).toContain('{ "host": "shop.example.com", "testMode": "shopify-test" }');

  expect(await hintFor([TEST], 'shop.example.com', 'step "payment-1": test mode not detected (the page is not on the allowed test payment host)')).toBeUndefined();
  expect(await hintFor([TEST], 'shop.example.com', 'step "payment-1": card frame not found (number)')).toBeUndefined();
});

test('the hint names the provider of the payment step that failed', async () => {
  const hint = await hintFor([BOGUS, TEST], 'shop.example.com', 'step "payment-2": test mode not detected');
  expect(hint).toContain('"testMode": "shopify-test"');
  expect(hint).not.toContain('shopify-bogus');
});

test('the hint lists each provider when the step cannot be identified', async () => {
  const hint = await hintFor([BOGUS, TEST], 'shop.example.com', 'test mode not detected');
  expect(hint).toContain('"testMode": "shopify-bogus"');
  expect(hint).toContain('"testMode": "shopify-test"');
});

test('no hint for an entry the allowlist file refuses', async () => {
  const failure = 'step "payment-1": test mode not detected';
  expect(await hintFor([FIXTURE], 'shop.example.com', failure)).toBeUndefined();
  expect(await hintFor([FIXTURE], 'localhost', failure)).toBeUndefined();
  expect(await hintFor([TEST], 'localhost', failure, true)).toBeUndefined();
  expect(await hintFor([FIXTURE], 'localhost', failure, true)).toContain('{ "host": "localhost", "testMode": "fixture" }');
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
