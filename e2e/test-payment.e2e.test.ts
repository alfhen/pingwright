import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { run, runCli, scenario, site, outDir, SANDBOX } from './cli-helpers.ts';

const CARD = '4242424242424242';
const CARD_SPACED = '4242 4242 4242 4242';
const EMAIL = 'pw-fixture@example.com';
const EMAIL_HASH = createHash('sha256').update(EMAIL).digest('hex');
const SEAM = 'TAGREEVE_TEST_LOOPBACK_IS_HOSTED';
const HANDOFF_REQUIRED = 'Payments and log-ins must be handoff steps';

async function config(hosts: unknown, mode = 0o600): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), 'pw-e2e-xdg-'));
  await mkdir(join(root, 'tagreeve'));
  const file = join(root, 'tagreeve', 'test-payment-hosts.json');
  await writeFile(file, JSON.stringify(hosts));
  await chmod(file, mode);
  return { XDG_CONFIG_HOME: root, [SEAM]: '1' };
}

const allow = (host: string) => ['--allow-test-payment', host];

beforeEach(() => {
  site.cardSubmits.length = 0;
});

test('all gates pass: the card is typed into the frame, recorded by name only and redacted until the run ends', async () => {
  const env = await config(['localhost']);
  const r = await run('test-payment', allow('localhost'), env);
  expect(r.code, r.stderr).toBe(0);
  expect(r.failed.filter((f) => f !== SANDBOX)).toEqual([]);
  expect(site.cardSubmits).toEqual([CARD]);
  const step = r.records!.steps.find((s) => s.payment);
  expect(step?.payment).toEqual({ provider: 'fixture', mode: 'test', testMode: 'marker' });
  expect(JSON.parse(r.stdout).testPayment).toEqual({ provider: 'fixture', host: 'localhost', testMode: 'marker' });
  expect(r.records!.run.testLoopbackHosted).toBe(true);
  expect(r.stderr).toContain(`${SEAM} is set`);

  const submit = r.records!.requests.filter((q) => q.url.endsWith('/card-submit'));
  expect(submit).toHaveLength(1);
  expect(submit[0]).toMatchObject({ redacted: 'handoff', postData: '[redacted]' });

  expect(site.cardExtras).toEqual(['12/40|123']);

  const summary = JSON.parse(r.stdout) as { path: string };
  const raw = await readFile(summary.path, 'utf8');
  const reportPath = join(outDir, 'test-payment-report.html');
  const report = await runCli(['report', summary.path, '--html', reportPath]);
  expect(report.code, report.stderr).toBe(0);
  const html = await readFile(reportPath, 'utf8');
  const messages = JSON.stringify(r.records!.steps.map((s) => [s.label, s.error, s.payment]));
  const outputs = [raw, html, r.stdout, r.stderr, report.stdout, report.stderr];

  for (const text of outputs) {
    for (const value of [CARD, CARD_SPACED, '12/40']) expect(text).not.toContain(value);
    expect(text).not.toMatch(/"123"|cc-csc[^\n]{0,40}123/);
  }
  const added = JSON.stringify([step?.payment, JSON.parse(r.stdout).testPayment]);
  for (const text of [added, messages, r.stderr]) {
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(EMAIL_HASH);
  }
}, 120_000);

test('the text summary prints the TEST PAYMENT line and no card value', async () => {
  const env = await config(['localhost']);
  const r = await runCli(['run', scenario('test-payment'), '--site', site.url, '--out', outDir, ...allow('localhost')], env);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain('TEST PAYMENT: fixture on localhost (test mode on page)');
  expect(r.stdout + r.stderr).not.toMatch(/4242|12\/40/);
}, 120_000);

test.each([
  ['no flag', [], ['localhost'], '--allow-test-payment localhost'],
  ['a flag for another host', allow('127.0.0.1'), ['localhost', '127.0.0.1'], 'must name the --site host'],
  ['a host that is not in the file', allow('localhost'), ['other.example.com'], 'is not in'],
])('%s: exit 2 before the browser starts and nothing is typed', async (_name, flags, hosts, message) => {
  const r = await run('test-payment', flags, await config(hosts));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain(message);
  expect(r.stderr).not.toContain('Run failed');
  expect(r.records).toBeUndefined();
  expect(site.cardSubmits).toEqual([]);
}, 60_000);

test('an allowlist file that others can write is refused', async () => {
  const r = await run('test-payment', allow('localhost'), await config(['localhost'], 0o666));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('must not be writable by group or others');
  expect(site.cardSubmits).toEqual([]);
}, 60_000);

test('without the test-mode marker the step fails and nothing is typed', async () => {
  const r = await run('test-payment-marker-off', allow('localhost'), await config(['localhost']));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('test mode not detected');
  expect(r.stderr).toContain('Declare it in');
  expect(site.cardSubmits).toEqual([]);
}, 120_000);

test('a card value outside the provider table is a scenario error that does not repeat it', async () => {
  const r = await run('test-payment-bad-card', allow('localhost'), await config(['localhost']));
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('is not a documented test value of fixture');
  expect(r.stderr).not.toContain('4000000000000002');
  expect(site.cardSubmits).toEqual([]);
}, 60_000);

test.each([
  ['fill', 'test-payment-fill-guard'],
  ['evaluate', 'test-payment-evaluate-guard'],
])('with the seam on, a %s of the top page card field still gets HANDOFF_REQUIRED, and without it the write works on loopback', async (_kind, name) => {
  const env = await config(['localhost']);
  const refused = await run(name, [], env);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain(HANDOFF_REQUIRED);
  const control = await run(name);
  expect(control.code, control.stderr).toBe(0);
  expect(control.records!.run).not.toHaveProperty('testLoopbackHosted');
}, 120_000);
