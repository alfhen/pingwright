import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { readRun } from '../packages/core/src/index.ts';
import { runCli, scenario, site, outDir, SANDBOX } from './cli-helpers.ts';

const CARD = '4242424242424242';
const CARD_SPACED = '4242 4242 4242 4242';
const EMAIL = 'pw-fixture@example.com';
const EMAIL_HASH = createHash('sha256').update(EMAIL).digest('hex');
const COOKIE_VALUE = 'pw-fixture-cookie-value';
const SEAM = 'TAGREEVE_TEST_LOOPBACK_IS_HOSTED';

async function env(): Promise<Record<string, string>> {
  const root = await mkdtemp(join(tmpdir(), 'pw-e2e-xdg-'));
  await mkdir(join(root, 'tagreeve'));
  const file = join(root, 'tagreeve', 'test-payment-hosts.json');
  await writeFile(file, JSON.stringify(['localhost']));
  await chmod(file, 0o600);
  return { XDG_CONFIG_HOME: root, [SEAM]: '1' };
}

/** A failed run prints no summary, so the record comes from the `Record:` line on stderr. */
async function play(name: string) {
  const r = await runCli(['run', scenario(name), '--site', site.url, '--out', outDir, '--json', '--allow-test-payment', 'localhost'], await env());
  const path = /^Record: (.+)$/m.exec(r.stderr)?.[1] ?? (r.stdout ? (JSON.parse(r.stdout) as { path: string }).path : undefined);
  const records = r.records ?? (path ? await readRun(path) : undefined);
  return { ...r, records };
}

function expectNoLeak(r: { stdout: string; stderr: string; records: Awaited<ReturnType<typeof play>>['records'] }): void {
  const urls = (r.records?.requests ?? []).map((q) => q.url).join('\n');
  // Each value must really be in a recorded URL, or the absence check below proves nothing.
  expect(urls).toContain(COOKIE_VALUE);
  expect(urls).toContain(EMAIL_HASH);
  expect(urls).toMatch(/pw-fixture(@|%40)example\.com/);
  for (const text of [r.stdout, r.stderr]) {
    for (const value of [CARD, CARD_SPACED, '12/40', EMAIL, EMAIL_HASH, COOKIE_VALUE]) expect(text).not.toContain(value);
    expect(text).not.toMatch(/pw-fixture(@|%40)example/);
  }
}

beforeEach(() => {
  site.cardSubmits.length = 0;
  site.cardExtras.length = 0;
});

test.each([
  ['a hidden duplicate frame before the real one', 'dup-first'],
  ['a hidden duplicate frame after the real one', 'dup-second'],
  ['a hidden extra input inside the card frame', 'dup-input'],
  ['one frame per field, marker in the common ancestor', 'split-inside'],
])('%s: the card is typed into the verified frame and submitted', async (_name, page) => {
  const r = await play(`test-payment-frames-${page}`);
  expect(r.code, r.stderr).toBe(0);
  expect(r.failed.filter((f) => f !== SANDBOX && f !== 'builtin: deniedIdentifiers')).toEqual([]);
  expect(r.stderr).not.toContain('could not be filled');
  expect(site.cardSubmits).toEqual([CARD]);
  expect(r.records!.steps.find((s) => s.payment)?.payment).toEqual({ provider: 'fixture', mode: 'test', testMode: 'marker' });
  expectNoLeak(r);
}, 120_000);

test('split frames with the marker outside their common ancestor: test mode is not detected and nothing is submitted', async () => {
  const r = await play('test-payment-frames-split-outside');
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('test mode not detected');
  expect(r.stderr).not.toContain('card frame not found');
  expect(site.cardSubmits).toEqual([]);
  expect(site.cardExtras).toEqual([]);
  expectNoLeak(r);
}, 120_000);
