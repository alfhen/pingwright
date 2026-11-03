import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSummary } from '../packages/cli/src/summary.ts';
import { createIdentity, hashEmail, hashPhone, normalizePhone } from '../packages/core/src/identity.ts';
import type { Hit, Request, Run, TagreeveRecord } from '../packages/core/src/records.ts';
import { readRun, type RunRecords } from '../packages/core/src/store.ts';
import { STORY_HOST } from '../site/src/lib/demo-data.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export const demoDir = join(root, 'site/demo');
export const demoScenarios = ['undecided', 'accept', 'reject'] as const;
export type DemoScenario = (typeof demoScenarios)[number];

/** The `--seed` of every recorded run, so a test can rebuild each fake identity. `suite` is the seed of the suite. */
export const demoSeeds = { undecided: 7101, accept: 7102, reject: 7103, suite: 7105 } as const;

/** The host each fixture server has in the demo files. */
export const demoHosts = {
  url: STORY_HOST,
  sgtmUrl: 'sgtm.northwind.example',
  thirdPartyUrl: 'pixel.adnetwork.example',
  containerUrl: 'gtm.northwind.example',
  paymentFrameUrl: 'pay.northwind.example',
} as const;

export type FixtureOrigins = Record<keyof typeof demoHosts, string>;

const keptTypes = new Set<TagreeveRecord['type']>(['run', 'step', 'request', 'hit', 'consentEpoch', 'result', 'flag']);

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackHost = /\b(?:localhost|127\.0\.0\.1)(?::\d+)?(?!\d)/g;
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isLoopback(url: string): boolean {
  try {
    return loopback.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function originAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin === 'null' ? `${u.protocol}${u.pathname}` : `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}

/**
 * Keeps what the site and `tagreeve diff` read and drops every value a page or a vendor could have set: the fake
 * identity and its seed, query strings, bodies, headers (cookies), hit parameters, data layer pushes and checkpoints.
 * Only requests to the fixture's own loopback hosts are kept, so no vendor or store host is in the file.
 */
export function scrubRecords(records: TagreeveRecord[]): TagreeveRecord[] {
  const out: TagreeveRecord[] = [];
  for (const record of records) {
    if (!keptTypes.has(record.type)) continue;
    if (record.type === 'run') {
      const run: Run = { ...record, identity: null };
      delete run.identitySeed;
      out.push(run);
    } else if (record.type === 'request') {
      if (!isLoopback(record.url)) continue;
      const request: Request = {
        ...record,
        url: originAndPath(record.url),
        frameUrl: record.frameUrl && originAndPath(record.frameUrl),
        initiator: null,
        headers: {},
        postData: null,
      };
      out.push(request);
    } else if (record.type === 'hit') {
      const hit: Hit = {
        ...record,
        page: record.page && originAndPath(record.page),
        params: {},
        consent: { ...record.consent, raw: pick(record.consent.raw, ['gcs', 'gcd']) },
      };
      if (hit.ids.hashes) hit.ids = { ...hit.ids, hashes: Object.fromEntries(Object.keys(hit.ids.hashes).map((k) => [k, { present: true, matchesIdentity: null }])) };
      out.push(hit);
    } else {
      out.push(record);
    }
  }
  return out;
}

function pick(raw: Record<string, string>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => k in raw).map((k) => [k, raw[k]!]));
}

/**
 * Puts the demo host of each fixture server in place of its loopback origin, so the files tell the story of
 * `--site https://staging.northwind.example`. A hit page without a port is the shop's.
 */
export function rewriteHosts(text: string, origins: FixtureOrigins): string {
  let out = text;
  for (const key of Object.keys(demoHosts) as (keyof FixtureOrigins)[]) {
    const origin = origins[key];
    const host = new URL(origin).host;
    out = out.replace(new RegExp(`${escape(origin)}(?!\\d)`, 'g'), `https://${demoHosts[key]}`);
    out = out.replace(new RegExp(`${escape(host)}(?!\\d)`, 'g'), demoHosts[key]);
  }
  return out.replace(/http:\/\/localhost(?![:\w])/g, `https://${demoHosts.url}`);
}

/** Every form of one seed's fake email and phone that must never be in a demo file. */
export function identityValues(seed: number): string[] {
  const { email, phone } = createIdentity(seed);
  const e164 = normalizePhone(phone);
  return [email, phone, e164, ...Object.values(hashEmail(email)), ...Object.values(hashPhone(phone))];
}

const allowedHosts = new Set<string>(Object.values(demoHosts));

/**
 * What in `text` a demo file must not hold: a fake identity of one of the seeds, the seed field, a consent cookie
 * value, the old store host, a fixture's loopback host or any host that is not a demo host.
 */
export function demoLeaks(text: string, seeds: readonly number[] = Object.values(demoSeeds)): string[] {
  const found = seeds.flatMap(identityValues).filter((v) => text.includes(v));
  for (const marker of ['identitySeed', 'pw_consent=', 'northwind.dk']) if (text.includes(marker)) found.push(marker);
  for (const [url] of text.matchAll(/\bhttps?:\/\/[^\s"'\\)]+/g)) {
    const host = hostnameOf(url);
    if (!loopback.has(host) && !allowedHosts.has(host)) found.push(url);
  }
  for (const [host] of text.matchAll(loopbackHost)) found.push(host);
  return found;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, 'dist/cli.js'), ...args], { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 2) : 0, stdout, stderr });
    });
  });
}

function check(what: string, result: CliResult): CliResult {
  if (result.code !== 0 && result.code !== 1) throw new Error(`${what} exited ${result.code}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function readRecords(path: string): Promise<TagreeveRecord[]> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TagreeveRecord);
}

const toJsonl = (records: TagreeveRecord[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** The first result of the summary that `tagreeve run --json` prints for this record, as `jq '.results[0]'` shows it. */
export function firstJsonResult(records: RunRecords, path: string): string {
  const first = buildSummary(records, records.results, path).results[0];
  if (!first) throw new Error(`${records.run.id}: the record has no results`);
  return JSON.stringify(first, null, 2) + '\n';
}

async function record(): Promise<void> {
  if (!existsSync(join(root, 'dist/cli.js'))) throw new Error('dist/cli.js is missing. Run pnpm build first.');
  const { startFixtureSite } = await import('../fixtures/site/src/index.ts');
  const site = await startFixtureSite();
  const cache = join(root, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const work = await mkdtemp(join(cache, 'tagreeve-site-demo-'));
  const written = new Map<string, string>();
  try {
    await cp(join(demoDir, 'scenarios'), join(work, 'tagreeve'), { recursive: true });
    const clean = join(work, 'clean');
    await mkdir(join(clean, 'runs'), { recursive: true });
    const runIds = new Map<DemoScenario, string>();

    for (const s of demoScenarios) {
      console.error(`Recording ${s}`);
      const result = check(s, await cli(['run', `tagreeve/${s}.yml`, '--site', site.url, '--out', 'runs', '--seed', String(demoSeeds[s])], work));
      const path = /^Record: (\S+)$/m.exec(result.stdout)?.[1];
      if (!path) throw new Error(`${s}: no record path in the output\n${result.stdout}`);
      const raw = await readRecords(join(work, path));
      const identity = raw[0]?.type === 'run' ? raw[0].identity : null;
      if (identity?.email !== createIdentity(demoSeeds[s]).email) throw new Error(`${s}: the run's identity is not the one of seed ${demoSeeds[s]}`);
      if (/^Result: fail\b/m.test(result.stdout) !== (result.code === 1)) throw new Error(`${s}: the "Result:" line does not match exit ${result.code}`);
      const scrubbed = rewriteHosts(toJsonl(scrubRecords(raw)), site);
      const runId = /run_[0-9A-Z]+/.exec(path)![0];
      runIds.set(s, runId);
      await writeFile(join(clean, 'runs', `${runId}.jsonl`), scrubbed);
      written.set(`${s}.jsonl`, scrubbed);
      written.set(`${s}.txt`, rewriteHosts(result.stdout, site));
      if (s === 'reject') written.set('reject.json', rewriteHosts(firstJsonResult(await readRun(join(work, path)), path), site));
    }

    const diff = check('diff', await cli(['diff', `runs/${runIds.get('reject')}.jsonl`, `runs/${runIds.get('accept')}.jsonl`], clean));
    written.set('diff.txt', diff.stdout);

    console.error('Recording the suite');
    const suite = check('suite', await cli(['suite', 'tagreeve/', '--site', site.url, '--out', 'runs', '--seed', String(demoSeeds.suite)], work));
    written.set('suite.txt', rewriteHosts(suite.stderr + suite.stdout, site));

    for (const [name, text] of written) {
      const leaks = demoLeaks(text);
      if (leaks.length) throw new Error(`${name} holds ${leaks.join(', ')}. Nothing was written.`);
    }
    for (const [name, text] of written) await writeFile(join(demoDir, name), text);
    console.error(`Wrote ${[...written.keys()].map((n) => relative(root, join(demoDir, n))).join(', ')}`);
  } finally {
    await site.close();
    await rm(work, { recursive: true, force: true });
  }
}

// buildSummary and readRun load class parameter properties, which strip-only Node cannot run:
// pnpm build && node --experimental-transform-types scripts/record-site-demo.ts
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  record().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
