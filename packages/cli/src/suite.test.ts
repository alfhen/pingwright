import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId, RunWriter, type Run } from '@tagreeve/core';
import { createFakeDocker } from '../../recorder/src/server-container/fake-docker.test-helper.ts';
import { expect, test } from 'vitest';
import type { SuiteArgs } from './args.ts';
import { labelRecord, type RunOutcome, type RunSpec } from './run.ts';
import { buildBaseline } from './baseline.ts';
import { cellText, formatSuiteTable, suiteCommand, suiteExitCode, type SuiteManifest } from './suite.ts';

const VALID = 'start: /\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n';
const HANDOFF = 'start: /\nsteps:\n  - handoff: Pay with the test card\nexpect:\n  must: []\n  mustNot: []\n';
const FAKE_AUTH = 'pw-fake-auth-value-0001';

async function workDir(files: Record<string, string>): Promise<{ dir: string; out: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pw-suite-'));
  const dir = join(root, 'scenarios');
  await mkdir(dir);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { dir, out: join(root, 'runs') };
}

function args(dir: string, out: string, extra: Partial<SuiteArgs> = {}): SuiteArgs {
  return {
    command: 'suite',
    dir,
    site: 'https://shop.example.com/some/path?token=abc',
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

const pass: RunOutcome = { code: 0, summary: { ok: true, pass: true } as RunOutcome['summary'] };

function failing(rules: number, check?: string, severity: 'fail' | 'warn' = 'fail'): RunOutcome {
  const results = [
    ...Array.from({ length: rules }, (_, i) => ({ expectation: `mustNot: {"vendor":"meta","n":${i}}`, pass: false, severity, message: 'pw-fixture@example.com', evidence: [] })),
    ...(check ? [{ expectation: `builtin: ${check}`, pass: false, severity, message: undefined, evidence: [] }] : []),
    { expectation: 'must: {"vendor":"ga4"}', pass: true, severity: 'fail', message: undefined, evidence: [] },
  ];
  return { code: severity === 'fail' ? 1 : 0, summary: { ok: severity === 'warn', pass: false, results } as unknown as RunOutcome['summary'] };
}

function recorder(outcomes: (spec: RunSpec) => RunOutcome | Promise<RunOutcome> = () => pass) {
  const specs: RunSpec[] = [];
  return {
    specs,
    run: async (spec: RunSpec) => {
      specs.push(spec);
      return outcomes(spec);
    },
  };
}

async function override(dir: string): Promise<string> {
  const path = join(dir, '..', 'secret-place-override.json');
  await writeFile(path, JSON.stringify({ container: 'GTM-PWTEST1', gtmAuth: FAKE_AUTH, gtmPreview: 'env-99' }));
  return path;
}

test('non-YAML files are ignored and subdirectories are not scanned', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yaml': VALID, 'notes.md': '# x', 'c.json': '{}' });
  await mkdir(join(dir, 'nested'));
  await writeFile(join(dir, 'nested', 'd.yml'), VALID);
  const fake = recorder();
  expect(await suiteCommand(args(dir, out), capture().io, fake)).toBe(0);
  expect(fake.specs.map((s) => s.scenarioName)).toEqual(['a', 'b']);
});

test('a server subfolder is skipped, even with scenarios that would fail to parse', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  await mkdir(join(dir, 'server'));
  await writeFile(join(dir, 'server', 's.yml'), VALID);
  await writeFile(join(dir, 'server', 'broken.yml'), 'not: [a scenario');
  const fake = recorder();
  expect(await suiteCommand(args(dir, out), capture().io, fake)).toBe(0);
  expect(fake.specs.map((s) => s.scenarioName)).toEqual(['a']);
});

test('one invalid scenario exits 2 before any run and lists every problem', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'bad.yml': 'steps: nope\n', 'worse.yaml': 'start: 3\nbogus: 1\n' });
  const fake = recorder();
  const c = capture();
  expect(await suiteCommand(args(dir, out), c.io, fake)).toBe(2);
  expect(fake.specs).toEqual([]);
  expect(c.err()).toContain('bad.yml is not a valid scenario');
  expect(c.err()).toContain('worse.yaml is not a valid scenario');
  await expect(readdir(out)).rejects.toThrow();
});

test('two files with the same scenario name exit 2', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'a.yaml': VALID });
  const c = capture();
  expect(await suiteCommand(args(dir, out), c.io, recorder())).toBe(2);
  expect(c.err()).toContain('another file has the scenario name "a"');
});

test('an empty directory and a missing override file exit 2 without naming the file', async () => {
  const empty = await workDir({ 'notes.md': 'x' });
  expect(await suiteCommand(args(empty.dir, empty.out), capture().io, recorder())).toBe(2);
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const secretPath = join(dir, 'missing-override.json');
  const c = capture();
  const variants = [{ name: 'published' }, { name: 'workspace', file: secretPath }];
  expect(await suiteCommand(args(dir, out, { variants }), c.io, recorder())).toBe(2);
  expect(c.err()).toContain('variant "workspace"');
  expect(c.err()).not.toContain(secretPath);
});

test('exit code order: a run that did not finish, then a failure, then pass', () => {
  const code = (...exitCodes: (0 | 1 | 2)[]) => suiteExitCode(exitCodes.map((exitCode) => ({ exitCode })));
  expect(code(0, 1, 2)).toBe(2);
  expect(code(0, 1)).toBe(1);
  expect(code(0, 0)).toBe(0);
  expect(code()).toBe(0);
});

test('a failing and an erroring run set the exit code and do not stop the suite', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID, 'c.yml': VALID });
  const fail = failing(2, 'deniedIdentifiers');
  const fake = recorder((s) => (s.scenarioName === 'a' ? fail : s.scenarioName === 'b' ? { code: 2, error: 'Run failed: banner not shown\n' } : pass));
  const c = capture();
  expect(await suiteCommand(args(dir, out), c.io, fake)).toBe(2);
  expect(fake.specs).toHaveLength(3);
  expect(c.out()).toMatch(/a\s+FAIL/);
  expect(c.out()).toMatch(/b\s+ERROR/);
  expect(c.out()).toContain('b published: run did not finish (exit 2), details in the stderr above');
  expect(c.out()).not.toContain('banner not shown');
  const failOnly = recorder((s) => (s.scenarioName === 'a' ? fail : pass));
  expect(await suiteCommand(args(dir, out), capture().io, failOnly)).toBe(1);
});

test('a warning result is WARN with exit 0', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const c = capture();
  const warn = failing(1, undefined, 'warn');
  expect(await suiteCommand(args(dir, out), c.io, recorder(() => warn))).toBe(0);
  expect(c.out()).toMatch(/a\s+WARN/);
});

test('handoff scenarios are skipped without --with-handoff, and run last with it', async () => {
  const { dir, out } = await workDir({ 'a-pay.yml': HANDOFF, 'b.yml': VALID });
  const variants = [{ name: 'published' }, { name: 'ws', file: await override(dir) }];
  const skipped = recorder();
  const c = capture();
  expect(await suiteCommand(args(dir, out, { variants }), c.io, skipped)).toBe(0);
  expect(skipped.specs.map((s) => s.scenarioName)).toEqual(['b', 'b']);
  expect(c.out()).toMatch(/a-pay\s+SKIPPED\s+SKIPPED/);

  const withHandoff = recorder();
  await suiteCommand(args(dir, out, { withHandoff: true }), capture().io, withHandoff);
  expect(withHandoff.specs.map((s) => s.scenarioName)).toEqual(['b', 'a-pay']);
});

test('--viewport reaches every run, and no flag passes undefined', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID });
  const variants = [{ name: 'published' }, { name: 'ws', file: await override(dir) }];
  const viewport = { width: 390, height: 844 };
  const withFlag = recorder();
  await suiteCommand(args(dir, out, { variants, viewport }), capture().io, withFlag);
  expect(withFlag.specs.map((s) => s.viewport)).toEqual([viewport, viewport, viewport, viewport]);
  const without = recorder();
  await suiteCommand(args(dir, out), capture().io, without);
  expect(without.specs.map((s) => s.viewport)).toEqual([undefined, undefined]);
});

test('a skipped handoff scenario between two others gets exactly one table row', async () => {
  const { dir, out } = await workDir({ 'accept.yml': VALID, 'checkout.yml': HANDOFF, 'reject.yml': VALID });
  const variants = [{ name: 'published' }, { name: 'ws', file: await override(dir) }];
  for (const withVariants of [[{ name: 'published' }], variants]) {
    const c = capture();
    await suiteCommand(args(dir, out, { variants: withVariants }), c.io, recorder());
    const rows = c.out().split('\n').filter((l) => /^(accept|checkout|reject)\s/.test(l));
    expect(rows.map((l) => l.split(/\s+/)[0])).toEqual(['accept', 'checkout', 'reject']);
    expect(rows[1]).toMatch(/^checkout\s+SKIPPED/);
  }
});

test('every variant of a scenario gets the same seed', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID });
  const variants = [{ name: 'published' }, { name: 'ws', file: await override(dir) }];
  const fake = recorder();
  await suiteCommand(args(dir, out, { variants }), capture().io, fake);
  const seeds = (name: string) => fake.specs.filter((s) => s.scenarioName === name).map((s) => s.seed);
  expect(seeds('a')[0]).toBeTypeOf('number');
  expect(seeds('a')[0]).toBe(seeds('a')[1]);
  expect(seeds('b')[0]).toBe(seeds('b')[1]);
  const fixed = recorder();
  await suiteCommand(args(dir, out, { seed: 7 }), capture().io, fixed);
  expect(fixed.specs.map((s) => s.seed)).toEqual([7, 7]);
});

test('the manifest holds no path, query, override file path or auth value', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const file = await override(dir);
  const c = capture();
  const variants = [{ name: 'published' }, { name: 'ws', file }];
  await suiteCommand(args(dir, out, { variants, json: true }), c.io, recorder());
  const [suiteDir] = await readdir(out);
  const text = await readFile(join(out, suiteDir!, 'suite.json'), 'utf8');
  const manifest = JSON.parse(text) as SuiteManifest;
  expect(manifest).toMatchObject({ suiteSchemaVersion: 3, site: 'https://shop.example.com', stores: [], variants: ['published', 'ws'], exitCode: 0 });
  expect(manifest.cells).toHaveLength(2);
  expect(manifest.cells[0]).toMatchObject({ scenario: 'a', variant: 'published', labels: {}, status: 'pass', exitCode: 0 });
  for (const forbidden of [file, 'secret-place', FAKE_AUTH, '/some/path', 'token=abc']) {
    expect(text).not.toContain(forbidden);
    expect(c.out()).not.toContain(forbidden);
    expect(c.err()).not.toContain(forbidden);
  }
  expect(JSON.parse(c.out())).toEqual(manifest);
});

test('an error carrying a fake email, its hash and a cookie value stays out of the manifest and the table', async () => {
  const email = 'pw-fixture@example.com';
  const hash = createHash('sha256').update(email).digest('hex');
  const cookie = 'session-fake-cookie-value';
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const fake = recorder(() => ({ code: 2, error: `Run failed: cannot fill ${email} ${hash} ${cookie}\n` }));
  const c = capture();
  expect(await suiteCommand(args(dir, out, { json: true }), c.io, fake)).toBe(2);
  const [suiteDir] = await readdir(out);
  const text = await readFile(join(out, suiteDir!, 'suite.json'), 'utf8');
  for (const secret of [email, hash, cookie]) {
    expect(text).not.toContain(secret);
    expect(c.out()).not.toContain(secret);
  }
  const table = capture();
  await suiteCommand(args(dir, out), table.io, fake);
  expect(table.out()).toContain('a published: run did not finish (exit 2)');
  for (const secret of [email, hash, cookie, 'cannot fill']) expect(table.out()).not.toContain(secret);
});

test('an unfinished run with a record path points to the record and prints no error text', async () => {
  const email = 'pw-fixture@example.com';
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const fake = recorder(async (spec) => {
    const path = join(spec.out, 'a.published.jsonl');
    const run = { type: 'run', id: 'run_0123456789ABCDEFGHJKMNPQRS', scenario: 'a', site: 'http://localhost:1234', startedAt: 1_800_000_000_000 };
    await writeFile(path, `${JSON.stringify(run)}\n`);
    return { code: 2, path, error: `Run failed: cannot fill ${email}\n` };
  });
  const c = capture();
  expect(await suiteCommand(args(dir, out), c.io, fake)).toBe(2);
  const [suiteDir] = await readdir(out);
  const errors = c.out().split('\nErrors\n')[1]!.split('\n')[0];
  expect(errors).toBe(`  a published: run did not finish (exit 2), details in ${join(out, suiteDir!, 'a.published.jsonl')}`);
  expect(c.out()).not.toContain('the stderr above');
  for (const secret of [email, 'cannot fill']) expect(c.out()).not.toContain(secret);
});

test('the manifest stores only the origin of --site', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const c = capture();
  await suiteCommand(args(dir, out, { site: 'https://shop.example.com:8443/cart?token=abc#frag', json: true }), c.io, recorder());
  const [suiteDir] = await readdir(out);
  const text = await readFile(join(out, suiteDir!, 'suite.json'), 'utf8');
  expect(JSON.parse(text).site).toBe('https://shop.example.com:8443');
  for (const part of ['/cart', 'token', 'abc', 'frag']) expect(text).not.toContain(part);
});

test('the table shows one diff column per extra variant and the record paths', () => {
  const cell = (scenario: string, variant: string, status: SuiteManifest['cells'][number]['status']) => ({
    scenario,
    variant,
    labels: {},
    status,
    exitCode: 0 as const,
    ...(status === 'skipped' ? {} : { record: `${scenario}.${variant}.jsonl` }),
  });
  const manifest: SuiteManifest = {
    suiteSchemaVersion: 1,
    id: 'suite_X',
    startedAt: 0,
    site: 'https://shop.example.com',
    stores: [],
    variants: ['published', 'workspace'],
    cells: [
      cell('checkout', 'published', 'pass'),
      cell('checkout', 'workspace', 'fail'),
      cell('consent', 'published', 'pass'),
      cell('consent', 'workspace', 'pass'),
      cell('pay', 'published', 'skipped'),
      cell('pay', 'workspace', 'skipped'),
    ],
    diffs: [
      { scenario: 'checkout', from: 'published', to: 'workspace', added: 1, removed: 0, changed: 1, flagsChanged: 0 },
      { scenario: 'consent', from: 'published', to: 'workspace', added: 0, removed: 0, changed: 0, flagsChanged: 0 },
    ],
    exitCode: 1,
  };
  const lines = formatSuiteTable(manifest, 'runs/suite_X').split('\n');
  expect(lines[0]).toMatch(/^scenario\s+published\s+workspace\s+diff \(published -> workspace\)$/);
  expect(lines[1]).toMatch(/^checkout\s+PASS\s+FAIL\s+\+1 added, 1 changed$/);
  expect(lines[2]).toMatch(/^consent\s+PASS\s+PASS\s+no change$/);
  expect(lines[3]).toMatch(/^pay\s+SKIPPED\s+SKIPPED$/);
  expect(lines).toContain('  checkout workspace: runs/suite_X/checkout.workspace.jsonl');
  expect(lines.join('\n')).not.toContain('pay published:');
});

test('--var applies to scenarios that declare it and is refused when none does', async () => {
  const declared = 'start: /\nvars:\n  product: tee\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n';
  const { dir, out } = await workDir({ 'a.yml': declared, 'b.yml': VALID });
  const fake = recorder();
  expect(await suiteCommand(args(dir, out, { vars: { product: 'mug' } }), capture().io, fake)).toBe(0);
  expect(fake.specs.map((s) => s.parsed.vars)).toEqual([{ product: 'mug' }, {}]);
  const c = capture();
  expect(await suiteCommand(args(dir, out, { vars: { nope: '1' } }), c.io, recorder())).toBe(2);
  expect(c.err()).toContain('--var nope not declared');
});

test('a failing cell names the failed rule count and built-in checks, and no message or rule text', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID, 'c.yml': VALID });
  const c = capture();
  const fake = recorder((s) => (s.scenarioName === 'a' ? failing(5, 'deniedIdentifiers') : s.scenarioName === 'b' ? failing(1, undefined, 'warn') : pass));
  await suiteCommand(args(dir, out), c.io, fake);
  expect(c.out()).toMatch(/a\s+FAIL: 5 rules, deniedIdentifiers\n/);
  expect(c.out()).toMatch(/b\s+WARN: 1 rule\n/);
  expect(c.out()).toMatch(/c\s+PASS\n/);
  expect(c.out()).not.toContain('pw-fixture@example.com');
  expect(c.out()).not.toContain('"vendor"');
});

test('cell text: a check-only failure, a warn with a check, an unfinished run and a cell from an older manifest', () => {
  expect(cellText({ status: 'fail', exitCode: 1, failed: { rules: 0, checks: ['sandboxPageUrl'] } })).toBe('FAIL: sandboxPageUrl');
  expect(cellText({ status: 'warn', exitCode: 0, failed: { rules: 2, checks: ['unloadGap'] } })).toBe('WARN: 2 rules, unloadGap');
  expect(cellText({ status: 'error', exitCode: 2 })).toBe('ERROR (exit 2)');
  expect(cellText({ status: 'fail', exitCode: 1 })).toBe('FAIL');
  expect(cellText({ status: 'pass', exitCode: 0 })).toBe('PASS');
});

const DECLARED = 'start: /\nvars:\n  product: tee\n  size: m\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n';
const PAYMENT = 'start: /\nsteps:\n  - payment: { provider: fixture, card: "4242424242424242" }\nexpect:\n  must: []\n  mustNot: []\n';

async function storesFile(dir: string, stores: unknown[]): Promise<string> {
  const path = join(dir, '..', 'stores.json');
  await writeFile(path, JSON.stringify({ storesSchemaVersion: 1, stores }));
  return path;
}

async function manifestOf(out: string): Promise<SuiteManifest> {
  const [suiteDir] = await readdir(out);
  return JSON.parse(await readFile(join(out, suiteDir!, 'suite.json'), 'utf8')) as SuiteManifest;
}

test('--stores runs every scenario against every store with a store label and file stem', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID });
  const stores = await storesFile(dir, [
    { name: 'se', site: 'https://shop.example.se/path?token=abc', country: 'SE' },
    { name: 'de', site: 'https://shop.example.de' },
  ]);
  const fake = recorder();
  const c = capture();
  const variants = [{ name: 'published' }, { name: 'ws' }];
  expect(await suiteCommand(args(dir, out, { site: undefined, stores, variants }), c.io, fake)).toBe(0);
  expect(fake.specs.map((s) => s.store)).toEqual(['se', 'se', 'de', 'de', 'se', 'se', 'de', 'de']);
  expect(fake.specs.map((s) => [s.scenarioName, s.site, s.variant])).toEqual([
    ['a', 'https://shop.example.se/path?token=abc', { name: 'published', fileStem: 'a.se' }],
    ['a', 'https://shop.example.se/path?token=abc', { name: 'ws', fileStem: 'a.se' }],
    ['a', 'https://shop.example.de', { name: 'published', fileStem: 'a.de' }],
    ['a', 'https://shop.example.de', { name: 'ws', fileStem: 'a.de' }],
    ['b', 'https://shop.example.se/path?token=abc', { name: 'published', fileStem: 'b.se' }],
    ['b', 'https://shop.example.se/path?token=abc', { name: 'ws', fileStem: 'b.se' }],
    ['b', 'https://shop.example.de', { name: 'published', fileStem: 'b.de' }],
    ['b', 'https://shop.example.de', { name: 'ws', fileStem: 'b.de' }],
  ]);
  expect(new Set(fake.specs.filter((s) => s.scenarioName === 'a').map((s) => s.seed)).size).toBe(1);
  const manifest = await manifestOf(out);
  expect(manifest.suiteSchemaVersion).toBe(3);
  expect(manifest.site).toBe('https://shop.example.se');
  expect(manifest.stores).toEqual([
    { name: 'se', site: 'https://shop.example.se' },
    { name: 'de', site: 'https://shop.example.de' },
  ]);
  expect(manifest.cells).toHaveLength(8);
  expect(manifest.cells.slice(0, 4).map((x) => [x.scenario, x.labels, x.variant])).toEqual([
    ['a', { store: 'se' }, 'published'],
    ['a', { store: 'se' }, 'ws'],
    ['a', { store: 'de' }, 'published'],
    ['a', { store: 'de' }, 'ws'],
  ]);
  expect(JSON.stringify(manifest)).not.toContain('token=abc');
  expect(JSON.stringify(manifest)).not.toContain('/path');
  expect(c.out()).toMatch(/^scenario\s+store\s+published\s+ws\s+diff \(published -> ws\)$/m);
  expect(c.out()).toMatch(/^a\s+se\s+PASS\s+PASS\s+/m);
  expect(c.out()).toMatch(/^a\s+de\s+PASS\s+PASS\s+/m);
});

test('without --stores the cells have no labels and the manifest has no stores', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  await suiteCommand(args(dir, out), capture().io, recorder());
  const manifest = await manifestOf(out);
  expect(manifest.stores).toEqual([]);
  expect(manifest.cells[0]!.labels).toEqual({});
  expect(manifest.diffs.every((d) => d.store === undefined)).toBe(true);
});

test('diffs compare variants within one store', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const stores = await storesFile(dir, [
    { name: 'se', site: 'https://shop.example.se' },
    { name: 'de', site: 'https://shop.example.de' },
  ]);
  const fake = {
    run: async (spec: RunSpec): Promise<RunOutcome> => {
      const run = { type: 'run', id: newId('run'), scenario: 'a', variant: spec.variant!.name, site: spec.site, startedAt: 0, networkMode: 'stub' } as unknown as Run;
      const writer = await RunWriter.create(spec.out, run);
      await writer.close();
      const path = join(spec.out, `${spec.variant!.fileStem}.${spec.variant!.name}.jsonl`);
      await rename(writer.path, path);
      return { code: 0, path, summary: { ok: true, pass: true } as RunOutcome['summary'] };
    },
  };
  const variants = [{ name: 'published' }, { name: 'ws' }];
  await suiteCommand(args(dir, out, { site: undefined, stores, variants }), capture().io, fake);
  const manifest = await manifestOf(out);
  expect(manifest.diffs.map((d) => [d.scenario, d.store, d.from, d.to])).toEqual([
    ['a', 'se', 'published', 'ws'],
    ['a', 'de', 'published', 'ws'],
  ]);
});

test('var precedence is the scenario, then the store, then --var', async () => {
  const { dir, out } = await workDir({ 'a.yml': DECLARED });
  const stores = await storesFile(dir, [
    { name: 'one', site: 'https://one.example.com', vars: { product: 'pw-store-var-0001', size: 'l' } },
    { name: 'two', site: 'https://two.example.com' },
  ]);
  const fake = recorder();
  await suiteCommand(args(dir, out, { site: undefined, stores, vars: { size: 'pw-cli-var-0001' } }), capture().io, fake);
  expect(fake.specs.map((s) => s.parsed.vars)).toEqual([
    { product: 'pw-store-var-0001', size: 'pw-cli-var-0001' },
    { product: 'tee', size: 'pw-cli-var-0001' },
  ]);
  const files = await readdir(join(out, (await readdir(out))[0]!));
  const manifestText = await readFile(join(out, (await readdir(out))[0]!, 'suite.json'), 'utf8');
  expect(files).toContain('suite.json');
  expect(manifestText).not.toContain('pw-store-var-0001');
  expect(manifestText).not.toContain('pw-cli-var-0001');
});

test('a store var that no scenario declares exits 2 and names the store and var, not the value', async () => {
  const { dir, out } = await workDir({ 'a.yml': DECLARED });
  const stores = await storesFile(dir, [{ name: 'one', site: 'https://one.example.com', vars: { nope: 'pw-secret-value' } }]);
  const fake = recorder();
  const c = capture();
  expect(await suiteCommand(args(dir, out, { site: undefined, stores }), c.io, fake)).toBe(2);
  expect(c.err()).toContain('Store "one": var nope');
  expect(c.err()).not.toContain('pw-secret-value');
  expect(fake.specs).toEqual([]);
});

test('a bad stores file exits 2 before any run', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const stores = await storesFile(dir, [{ name: 'Bad', site: 'https://x.test' }]);
  const fake = recorder();
  const c = capture();
  expect(await suiteCommand(args(dir, out, { site: undefined, stores }), c.io, fake)).toBe(2);
  expect(c.err()).toContain('store 0 needs a name');
  expect(fake.specs).toEqual([]);
});

test('store country sets identity.country, and a scenario with another country gets a warning', async () => {
  const withCountry = 'start: /\nidentity:\n  country: DE\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\n';
  const { dir, out } = await workDir({ 'a.yml': withCountry, 'b.yml': VALID });
  const stores = await storesFile(dir, [{ name: 'se', site: 'https://shop.example.se', country: 'SE' }]);
  const fake = recorder();
  const c = capture();
  await suiteCommand(args(dir, out, { site: undefined, stores }), c.io, fake);
  expect(fake.specs.map((s) => s.parsed.identity.country)).toEqual(['SE', 'SE']);
  expect(c.err()).toContain('Warning: a: identity.country differs from the country of store "se"');
  expect(c.err()).not.toContain('Warning: b:');
});

test('store autoconsent rules are added to the --autoconsent-rules of that store only', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const stores = await storesFile(dir, [
    { name: 'one', site: 'https://one.example.com', autoconsentRules: 'rules.json' },
    { name: 'two', site: 'https://two.example.com' },
  ]);
  await writeFile(join(dir, '..', 'rules.json'), '{}');
  const fake = recorder();
  await suiteCommand(args(dir, out, { site: undefined, stores, autoconsentRules: ['global.json'] }), capture().io, fake);
  expect(fake.specs.map((s) => s.autoconsentRules)).toEqual([['global.json', join(dir, '..', 'rules.json')], ['global.json']]);
});

test('a payment scenario runs only for the store whose host equals --allow-test-payment', async () => {
  const { dir, out } = await workDir({ 'pay.yml': PAYMENT });
  const stores = await storesFile(dir, [
    { name: 'local', site: 'http://localhost:4000' },
    { name: 'other', site: 'http://127.0.0.1:4000' },
  ]);
  const xdg = join(dir, '..', 'xdg');
  const hosts = join(xdg, 'tagreeve', 'test-payment-hosts.json');
  await mkdir(join(hosts, '..'), { recursive: true });
  await writeFile(hosts, JSON.stringify(['localhost']));
  await chmod(hosts, 0o600);
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const fake = recorder();
    const code = await suiteCommand(args(dir, out, { site: undefined, stores, withTestPayment: true, allowTestPayment: 'localhost' }), capture().io, fake);
    expect(code).toBe(0);
    expect(fake.specs.map((s) => s.site)).toEqual(['http://localhost:4000']);
    const manifest = await manifestOf(out);
    expect(manifest.cells.map((x) => [x.labels.store, x.status])).toEqual([
      ['local', 'pass'],
      ['other', 'skipped'],
    ]);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
});

async function allowHost(dir: string, host: string): Promise<() => void> {
  const xdg = join(dir, '..', 'xdg');
  const hosts = join(xdg, 'tagreeve', 'test-payment-hosts.json');
  await mkdir(join(hosts, '..'), { recursive: true });
  await writeFile(hosts, JSON.stringify([host]));
  await chmod(hosts, 0o600);
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdg;
  return () => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  };
}

test('--allow-test-payment that matches no store with --stores, --with-test-payment and a payment scenario exits 2 naming the flag', async () => {
  const { dir, out } = await workDir({ 'pay.yml': PAYMENT });
  const stores = await storesFile(dir, [
    { name: 'local', site: 'http://localhost:4000' },
    { name: 'other', site: 'http://127.0.0.1:4000' },
  ]);
  const restore = await allowHost(dir, 'localhots');
  try {
    const fake = recorder();
    const c = capture();
    const code = await suiteCommand(args(dir, out, { site: undefined, stores, withTestPayment: true, allowTestPayment: 'localhots' }), c.io, fake);
    expect(code).toBe(2);
    expect(c.err()).toContain('--allow-test-payment localhots');
    expect(c.err()).not.toContain('4000');
    expect(fake.specs).toEqual([]);
  } finally {
    restore();
  }
});

test('--allow-test-payment that matches no store is fine without a payment scenario or without --with-test-payment', async () => {
  const noPayment = await workDir({ 'a.yml': VALID });
  const stores = await storesFile(noPayment.dir, [{ name: 'local', site: 'http://localhost:4000' }]);
  expect(await suiteCommand(args(noPayment.dir, noPayment.out, { site: undefined, stores, withTestPayment: true, allowTestPayment: 'localhots' }), capture().io, recorder())).toBe(0);
  const pay = await workDir({ 'pay.yml': PAYMENT });
  const stores2 = await storesFile(pay.dir, [{ name: 'local', site: 'http://localhost:4000' }]);
  expect(await suiteCommand(args(pay.dir, pay.out, { site: undefined, stores: stores2, allowTestPayment: 'localhots' }), capture().io, recorder())).toBe(0);
});

test('the table names the store in the record and error lines', () => {
  const cell = (store: string, exitCode: 0 | 2) => ({
    scenario: 'a',
    variant: 'published',
    labels: { store },
    status: exitCode ? ('error' as const) : ('pass' as const),
    exitCode,
    record: `a.${store}.published.jsonl`,
  });
  const manifest: SuiteManifest = {
    suiteSchemaVersion: 2,
    id: 'suite_X',
    startedAt: 0,
    site: 'https://one.example.com',
    stores: [
      { name: 'one', site: 'https://one.example.com' },
      { name: 'two', site: 'https://two.example.com' },
    ],
    variants: ['published'],
    cells: [cell('one', 0), cell('two', 2)],
    diffs: [],
    exitCode: 2,
  };
  const text = formatSuiteTable(manifest, 'runs/suite_X');
  expect(text).toMatch(/^a\s+one\s+PASS$/m);
  expect(text).toMatch(/^a\s+two\s+ERROR \(exit 2\)$/m);
  expect(text).toContain('  a one published: runs/suite_X/a.one.published.jsonl');
  expect(text).toContain('  a two published: run did not finish (exit 2)');
});

const CONTAINER_SCENARIO = 'start: /\nsteps:\n  - visit: /\nexpect:\n  must: []\n  mustNot: []\noptions: { network: server, serverHosts: [127.0.0.1] }\n';

test('--server-container passes the same spec to every run', async () => {
  const { dir, out } = await workDir({ 'a.yml': CONTAINER_SCENARIO, 'b.yml': CONTAINER_SCENARIO });
  const fake = recorder();
  const saved = process.env.TAGREEVE_SERVER_CONTAINER_CONFIG;
  const savedSeam = process.env.TAGREEVE_TEST_SERVER_CONTAINER_CMD;
  const standIn = join(await mkdtemp(join(tmpdir(), 'pw-standin-')), 'standin');
  await writeFile(standIn, '#!/bin/sh\nexit 0\n');
  await chmod(standIn, 0o755);
  process.env.TAGREEVE_TEST_SERVER_CONTAINER_CMD = standIn;
  process.env.TAGREEVE_SERVER_CONTAINER_CONFIG = Buffer.from('id=GTM-PWTEST1&env=1&auth=pw-fixture-auth').toString('base64');
  try {
    expect(await suiteCommand(args(dir, out, { serverContainer: true }), capture().io, fake)).toBe(0);
  } finally {
    if (saved === undefined) delete process.env.TAGREEVE_SERVER_CONTAINER_CONFIG;
    else process.env.TAGREEVE_SERVER_CONTAINER_CONFIG = saved;
    if (savedSeam === undefined) delete process.env.TAGREEVE_TEST_SERVER_CONTAINER_CMD;
    else process.env.TAGREEVE_TEST_SERVER_CONTAINER_CMD = savedSeam;
  }
  expect(fake.specs).toHaveLength(2);
  expect(fake.specs.every((s) => s.serverContainer?.configSource.kind === 'env')).toBe(true);
});

test('--server-container with a missing image exits 2 before any scenario and prints the message once', async () => {
  const { dir, out } = await workDir({ 'a.yml': CONTAINER_SCENARIO, 'b.yml': CONTAINER_SCENARIO });
  const fake = recorder();
  const docker = createFakeDocker();
  const c = capture();
  const env = { ...docker.env({ noImage: true, images: ['0.4.0'] }), TAGREEVE_SERVER_CONTAINER_CONFIG: Buffer.from('id=GTM-PWTEST1&env=1&auth=pw-fixture-auth').toString('base64') };
  const saved = { ...process.env };
  Object.assign(process.env, env);
  delete process.env.TAGREEVE_TEST_SERVER_CONTAINER_CMD;
  try {
    expect(await suiteCommand(args(dir, out, { serverContainer: true }), c.io, fake)).toBe(2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
  expect(fake.specs).toEqual([]);
  expect(c.err().match(/is not available/g)).toHaveLength(1);
  expect(c.err()).toContain('tagreeve server-container build');
});

test('--server-container with a scenario that is not in server mode exits 2 before any run', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const fake = recorder();
  const c = capture();
  expect(await suiteCommand(args(dir, out, { serverContainer: true }), c.io, fake)).toBe(2);
  expect(fake.specs).toEqual([]);
  expect(c.err()).toContain('--server-container needs --network server');
});

test('without --server-container no run gets a server container spec', async () => {
  const { dir, out } = await workDir({ 'a.yml': CONTAINER_SCENARIO });
  const fake = recorder();
  expect(await suiteCommand(args(dir, out), capture().io, fake)).toBe(0);
  expect(fake.specs[0]).not.toHaveProperty('serverContainer');
});

test('--label goes to the manifest, the out folder and every spec', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const fake = recorder();
  expect(await suiteCommand(args(dir, out, { label: 'ca-307' }), capture().io, fake)).toBe(0);
  expect(fake.specs.map((s) => s.label)).toEqual(['ca-307']);
  expect((await manifestOf(out)).label).toBe('ca-307');
  const none = recorder();
  await suiteCommand(args(dir, join(out, 'again')), capture().io, none);
  expect(none.specs[0]).not.toHaveProperty('label');
  expect(await manifestOf(join(out, 'again'))).not.toHaveProperty('label');
});

test('labelRecord writes the label, the store and the variant on the run line and renames only a variant cell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pw-label-'));
  const writeRun = async (name: string): Promise<string> => {
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify({ type: 'run', id: 'run_1', scenario: 's' })}\n{"type":"step","id":"step_1"}\n`);
    return path;
  };
  const labelled = await labelRecord(await writeRun('a.jsonl'), { label: 'x', out: root });
  expect(labelled).toBe(join(root, 'a.jsonl'));
  const [first, second] = (await readFile(labelled, 'utf8')).split('\n');
  expect(JSON.parse(first!)).toMatchObject({ id: 'run_1', label: 'x' });
  expect(JSON.parse(first!)).not.toHaveProperty('variant');
  expect(second).toBe('{"type":"step","id":"step_1"}');

  const moved = await labelRecord(await writeRun('b.jsonl'), { label: 'x', store: 'se', variant: { name: 'ws', fileStem: 'a.se' }, out: root });
  expect(moved).toBe(join(root, 'a.se.ws.jsonl'));
  expect(JSON.parse((await readFile(moved, 'utf8')).split('\n')[0]!)).toMatchObject({ label: 'x', store: 'se', variant: 'ws' });

  const plain = await writeRun('c.jsonl');
  const before = await readFile(plain, 'utf8');
  expect(await labelRecord(plain, { out: root })).toBe(plain);
  expect(await readFile(plain, 'utf8')).toBe(before);
});

async function inProject<T>(files: Record<string, string>, body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pw-suite-proj-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), text);
  }
  const before = process.cwd();
  process.chdir(root);
  try {
    return await body(root);
  } finally {
    process.chdir(before);
  }
}

const STORES = JSON.stringify({
  storesSchemaVersion: 1,
  stores: [
    { name: 'one', site: 'https://one.example.com' },
    { name: 'two', site: 'https://two.example.com' },
  ],
});
const PROJECT = {
  'tagreeve/scenarios/a.yml': VALID,
  'tagreeve/trackers.json': '[]',
  'tagreeve/stores.json': STORES,
  'tagreeve/autoconsent/rules.json': '{}',
};

function bare(extra: Partial<SuiteArgs> = {}): SuiteArgs {
  const { dir, site, ...rest } = args('', 'out', extra);
  void dir;
  void site;
  return { ...rest, ...extra };
}

test('suite with no folder and no site uses the default folder, tracker list, rules and stores', async () => {
  await inProject(PROJECT, async (root) => {
    const fake = recorder();
    const c = capture();
    expect(await suiteCommand(bare({ out: join(root, 'out'), json: true }), c.io, fake)).toBe(0);
    expect(fake.specs.map((s) => [s.scenarioName, s.site])).toEqual([
      ['a', 'https://one.example.com'],
      ['a', 'https://two.example.com'],
    ]);
    expect(fake.specs[0]!.autoconsentRules).toEqual(['tagreeve/autoconsent/rules.json']);
    const manifest = JSON.parse(c.out()) as SuiteManifest;
    expect(manifest.defaults).toEqual([
      { setting: 'scenarios', path: 'tagreeve/scenarios' },
      { setting: 'trackerList', path: 'tagreeve/trackers.json' },
      { setting: 'autoconsentRules', path: 'tagreeve/autoconsent/rules.json' },
      { setting: 'stores', path: 'tagreeve/stores.json' },
    ]);
    expect(c.out()).not.toContain(root);
  });
});

test('the text table has one Defaults line, and none without a default', async () => {
  await inProject(PROJECT, async (root) => {
    const c = capture();
    await suiteCommand(bare({ out: join(root, 'out') }), c.io, recorder());
    expect(c.out().match(/^Defaults: /gm)).toHaveLength(1);
    expect(c.out()).toContain('tagreeve/stores.json (stores)');
  });
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const c = capture();
  await suiteCommand(args(dir, out), c.io, recorder());
  expect(c.out()).not.toContain('Defaults:');
});

test('a flag replaces its default, --site means stores.json is not used, and no key is written without defaults', async () => {
  await inProject(PROJECT, async (root) => {
    const fake = recorder();
    const c = capture();
    const a = bare({ out: join(root, 'out'), json: true, site: 'https://flag.example.com', trackerList: 'tagreeve/trackers.json', autoconsentRules: ['other.json'] });
    expect(await suiteCommand(a, c.io, fake)).toBe(0);
    expect(fake.specs.map((s) => s.site)).toEqual(['https://flag.example.com']);
    expect(fake.specs[0]!.autoconsentRules).toEqual(['other.json']);
    expect((JSON.parse(c.out()) as SuiteManifest).defaults).toEqual([{ setting: 'scenarios', path: 'tagreeve/scenarios' }]);
  });
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const c = capture();
  await suiteCommand(args(dir, out, { json: true }), c.io, recorder());
  expect(JSON.parse(c.out())).not.toHaveProperty('defaults');
});

test('suite with no site and no stores file, or no folder, names what is missing', async () => {
  await inProject({ 'tagreeve/scenarios/a.yml': VALID }, async () => {
    const c = capture();
    expect(await suiteCommand(bare(), c.io, recorder())).toBe(2);
    expect(c.err()).toContain('--site');
    expect(c.err()).toContain('--stores');
    expect(c.err()).toContain('tagreeve/stores.json');
  });
  await inProject({}, async () => {
    const c = capture();
    expect(await suiteCommand(bare({ site: 'https://x.example.com' }), c.io, recorder())).toBe(2);
    expect(c.err()).toContain('tagreeve/scenarios');
  });
});

test('--allow-test-payment needs --site or --stores on the command line, also when tagreeve/stores.json holds the host', async () => {
  const stores = JSON.stringify({ storesSchemaVersion: 1, stores: [{ name: 'local', site: 'http://localhost:3000' }] });
  await inProject({ ...PROJECT, 'tagreeve/stores.json': stores }, async (root) => {
    const fake = recorder();
    const c = capture();
    expect(await suiteCommand(bare({ out: join(root, 'out'), allowTestPayment: 'localhost' }), c.io, fake)).toBe(2);
    expect(c.err()).toContain('--allow-test-payment');
    expect(fake.specs).toEqual([]);
  });
});

const BASELINE_STATE = { analytics: 'denied', ads: 'denied', adUserData: 'denied', adPersonalization: 'denied' } as const;

async function cellRecord(root: string, name: string, events: string[]) {
  const runId = newId('run');
  const run = { type: 'run', id: runId, recordSchemaVersion: 4, scenario: name, site: 'https://shop.example.com', startedAt: 0, variant: 'published' };
  const epoch = { type: 'consentEpoch', id: newId('consentEpoch'), runId, startT: 0, endT: null, source: 'test', label: 'undecided', state: BASELINE_STATE };
  const hits = events.map((event, i) => ({
    type: 'hit', id: newId('hit'), runId, stepId: null, requestId: newId('request'), t: i, vendor: 'ga4', event,
    consent: { ...BASELINE_STATE, raw: {} }, ids: {}, page: 'https://shop.example.com/', transport: 'GET', params: {},
  }));
  const path = join(root, `${name}-${events.join('-')}.jsonl`);
  await writeFile(path, [run, epoch, ...hits].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

async function saveBaseline(folder: string, file: string, events: string[]) {
  const record = await cellRecord(await mkdtemp(join(tmpdir(), 'pw-base-rec-')), 'base', events);
  const { readRun } = await import('@tagreeve/core');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, file), JSON.stringify(buildBaseline(await readRun(record), false)));
}

test('suite --baseline marks a drifting cell FAIL, exits 1 and records the counts in the manifest', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID });
  const folder = join(dir, '..', 'baselines');
  await saveBaseline(folder, 'a.json', ['page_view']);
  await saveBaseline(folder, 'b.json', ['page_view']);
  const events: Record<string, string[]> = { a: ['page_view'], b: ['page_view', 'add_to_cart'] };
  const rec = recorder(async (spec) => ({ code: 0, summary: pass.summary, path: await cellRecord(spec.out, spec.scenarioName, events[spec.scenarioName]!) }));
  const c = capture();
  expect(await suiteCommand(args(dir, out, { baseline: folder }), c.io, rec)).toBe(1);
  expect(c.out()).toMatch(/b\s+FAIL \(baseline drift\)/);
  expect(c.out()).toMatch(/a\s+PASS\n/);
  expect(c.out()).toContain('b published: b.json: 1 added, 0 removed, 0 count changes');
  const manifest = JSON.parse(await readFile(join(out, (await readdir(out))[0]!, 'suite.json'), 'utf8')) as SuiteManifest;
  expect(manifest.suiteSchemaVersion).toBe(3);
  expect(manifest.exitCode).toBe(1);
  const cell = (name: string) => manifest.cells.find((x) => x.scenario === name)!;
  expect(cell('b')).toMatchObject({ status: 'fail', exitCode: 1, baseline: { file: 'b.json', drift: true, added: 1, removed: 0, countChanges: 0 } });
  expect(cell('a')).toMatchObject({ status: 'pass', exitCode: 0, baseline: { file: 'a.json', drift: false } });
});

test('without --baseline the same drifting cell passes', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const rec = recorder(async (spec) => ({ code: 0, summary: pass.summary, path: await cellRecord(spec.out, spec.scenarioName, ['page_view', 'add_to_cart']) }));
  expect(await suiteCommand(args(dir, out), capture().io, rec)).toBe(0);
});

test('suite --baseline exits 2 before any run and lists every missing file, store and variant names included', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'b.yml': VALID });
  const folder = join(dir, '..', 'baselines');
  await saveBaseline(folder, 'a.se.json', ['page_view']);
  const stores = join(dir, '..', 'stores.json');
  await writeFile(stores, JSON.stringify({ storesSchemaVersion: 1, stores: [{ name: 'se', site: 'https://se.example.com' }] }));
  const rec = recorder();
  const c = capture();
  const code = await suiteCommand(args(dir, out, { site: undefined, stores, baseline: folder, variants: [{ name: 'published' }] }), c.io, rec);
  expect(code).toBe(2);
  expect(rec.specs).toHaveLength(0);
  expect(c.err()).toContain(join(folder, 'b.se.json'));
  expect(c.err()).not.toContain('a.se.json');
  await expect(readdir(out)).rejects.toThrow();
});

test('a skipped handoff scenario needs no baseline file', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID, 'h.yml': HANDOFF });
  const folder = join(dir, '..', 'baselines');
  await saveBaseline(folder, 'a.json', ['page_view']);
  const rec = recorder(async (spec) => ({ code: 0, summary: pass.summary, path: await cellRecord(spec.out, spec.scenarioName, ['page_view']) }));
  expect(await suiteCommand(args(dir, out, { baseline: folder }), capture().io, rec)).toBe(0);
});

test('a bare --baseline uses tagreeve/baselines and names it in the defaults', async () => {
  await inProject({ 'tagreeve/scenarios/a.yml': VALID }, async (root) => {
    await saveBaseline(join(root, 'tagreeve/baselines'), 'a.json', ['page_view']);
    const rec = recorder(async (spec) => ({ code: 0, summary: pass.summary, path: await cellRecord(spec.out, spec.scenarioName, ['page_view']) }));
    const c = capture();
    expect(await suiteCommand(bare({ site: 'https://shop.example.com', baselineDefault: true, out: join(root, 'out') }), c.io, rec)).toBe(0);
    expect(c.out()).toContain('tagreeve/baselines (baseline)');
  });
});

test('cell text for a drifting cell', () => {
  expect(cellText({ status: 'fail', exitCode: 1, baseline: { drift: true } })).toBe('FAIL (baseline drift)');
  expect(cellText({ status: 'fail', exitCode: 1, failed: { rules: 1, checks: [] }, baseline: { drift: true } })).toBe('FAIL: 1 rule, baseline drift');
  expect(cellText({ status: 'pass', exitCode: 0, baseline: { drift: false } })).toBe('PASS');
});

const HINT = 'Run tagreeve suite --help for the options.';
const oldRuns = { 'runs/run_old.jsonl': '' };
const todayFolders = (): string[] => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const at = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return [at(new Date(Date.now() - 60_000)), at(new Date())];
};

test('the missing site, the missing folder and the test-payment refusals carry the suite help hint', async () => {
  await inProject({ 'tagreeve/scenarios/a.yml': VALID }, async () => {
    const c = capture();
    expect(await suiteCommand(bare(), c.io, recorder())).toBe(2);
    expect(c.err()).toContain('suite needs a site');
    expect(c.err()).toContain(HINT);
  });
  await inProject({}, async () => {
    const c = capture();
    expect(await suiteCommand(bare({ site: 'https://x.example.com' }), c.io, recorder())).toBe(2);
    expect(c.err()).toContain('suite needs a scenario folder');
    expect(c.err()).toContain(HINT);
  });
  await inProject({ 'tagreeve/scenarios/a.yml': VALID }, async () => {
    const c = capture();
    expect(await suiteCommand(bare({ allowTestPayment: 'localhost' }), c.io, recorder())).toBe(2);
    expect(c.err()).toContain('--allow-test-payment needs --site or --stores');
    expect(c.err()).toContain(HINT);
  });
  const { dir, out } = await workDir({ 'pay.yml': PAYMENT });
  const stores = await storesFile(dir, [{ name: 'local', site: 'http://localhost:4000' }]);
  const restore = await allowHost(dir, 'localhots');
  try {
    const c = capture();
    expect(await suiteCommand(args(dir, out, { site: undefined, stores, withTestPayment: true, allowTestPayment: 'localhots' }), c.io, recorder())).toBe(2);
    expect(c.err()).toContain('--allow-test-payment localhots');
    expect(c.err()).toContain(HINT);
  } finally {
    restore();
  }
});

test('without --out the suite folder is tagreeve/runs/<date>/suite_<id>/ and the notice names it once', async () => {
  await inProject({ 'tagreeve/scenarios/a.yml': VALID, ...oldRuns }, async (root) => {
    const c = capture();
    expect(await suiteCommand(bare({ out: undefined, site: 'https://x.example.com' }), c.io, recorder())).toBe(0);
    const [folder] = await readdir(join(root, 'tagreeve', 'runs'));
    expect(todayFolders()).toContain(folder);
    const inside = await readdir(join(root, 'tagreeve', 'runs', folder!));
    expect(inside).toHaveLength(1);
    expect(inside[0]).toMatch(/^suite_/);
    const notice = c.err().split('\n').filter((l) => l.includes('holds older records'));
    expect(notice).toHaveLength(1);
    expect(notice[0]).toContain(`records now go to ${join('tagreeve', 'runs', folder!)}/.`);
    expect(notice[0]).not.toContain('<date>');
  });
});

test('--out gives no notice, and a refused test payment prints no notice', async () => {
  await inProject({ 'tagreeve/scenarios/a.yml': VALID, ...oldRuns }, async (root) => {
    const c = capture();
    expect(await suiteCommand(bare({ out: join(root, 'o'), site: 'https://x.example.com' }), c.io, recorder())).toBe(0);
    expect(await readdir(join(root, 'o'))).toHaveLength(1);
    expect(c.err()).not.toContain('holds older records');
  });
  const files = { 'tagreeve/scenarios/pay.yml': PAYMENT, 'tagreeve/stores.json': STORES, ...oldRuns };
  await inProject(files, async () => {
    const c = capture();
    const refused = bare({ out: undefined, stores: 'tagreeve/stores.json', withTestPayment: true, allowTestPayment: 'localhots' });
    expect(await suiteCommand(refused, c.io, recorder())).toBe(2);
    expect(c.err()).toContain('--allow-test-payment localhots: no store');
    expect(c.err()).not.toContain('holds older records');
  });
});

test('a --stores cell record holds the store name and none of the store site, path, query or var values', async () => {
  const { dir, out } = await workDir({ 'a.yml': DECLARED });
  const stores = await storesFile(dir, [{ name: 'se', site: 'https://shop.example.se/private/path?token=abc', vars: { size: 'pw-secret-value' } }]);
  const written: string[] = [];
  const run = async (spec: RunSpec): Promise<RunOutcome> => {
    await mkdir(out, { recursive: true });
    const path = join(out, `raw-${written.length}.jsonl`);
    await writeFile(path, `${JSON.stringify({ type: 'run', id: 'run_1', scenario: spec.scenarioName })}\n`);
    written.push(await readFile(await labelRecord(path, spec), 'utf8'));
    return pass;
  };
  expect(await suiteCommand(args(dir, out, { site: undefined, stores }), capture().io, { run })).toBe(0);
  const runLine = JSON.parse(written[0]!.split('\n')[0]!) as Record<string, unknown>;
  expect(runLine.store).toBe('se');
  for (const leak of ['token=abc', 'private', 'pw-secret-value', 'shop.example.se']) expect(written[0]).not.toContain(leak);
});
