import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import type { SuiteArgs } from './args.ts';
import type { RunOutcome, RunSpec } from './run.ts';
import { formatSuiteTable, suiteCommand, suiteExitCode, type SuiteManifest } from './suite.ts';

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

function recorder(outcomes: (spec: RunSpec) => RunOutcome = () => pass) {
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
  const fail: RunOutcome = { code: 1, summary: { ok: false, pass: false } as RunOutcome['summary'] };
  const fake = recorder((s) => (s.scenarioName === 'a' ? fail : s.scenarioName === 'b' ? { code: 2, error: 'Run failed: banner not shown\n' } : pass));
  const c = capture();
  expect(await suiteCommand(args(dir, out), c.io, fake)).toBe(2);
  expect(fake.specs).toHaveLength(3);
  expect(c.out()).toMatch(/a\s+FAIL/);
  expect(c.out()).toMatch(/b\s+ERROR/);
  expect(c.out()).toContain('b published: Run failed: banner not shown');
  const failOnly = recorder((s) => (s.scenarioName === 'a' ? fail : pass));
  expect(await suiteCommand(args(dir, out), capture().io, failOnly)).toBe(1);
});

test('a warning result is WARN with exit 0', async () => {
  const { dir, out } = await workDir({ 'a.yml': VALID });
  const c = capture();
  const warn: RunOutcome = { code: 0, summary: { ok: true, pass: false } as RunOutcome['summary'] };
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
  expect(manifest).toMatchObject({ suiteSchemaVersion: 1, site: 'https://shop.example.com', variants: ['published', 'ws'], exitCode: 0 });
  expect(manifest.cells).toHaveLength(2);
  expect(manifest.cells[0]).toMatchObject({ scenario: 'a', variant: 'published', labels: {}, status: 'pass', exitCode: 0 });
  for (const forbidden of [file, 'secret-place', FAKE_AUTH, '/some/path', 'token=abc']) {
    expect(text).not.toContain(forbidden);
    expect(c.out()).not.toContain(forbidden);
    expect(c.err()).not.toContain(forbidden);
  }
  expect(JSON.parse(c.out())).toEqual(manifest);
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
