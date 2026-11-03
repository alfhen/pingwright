import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIdentity, hashEmail, hashPhone, normalizePhone } from '../packages/core/src/identity.ts';
import type { Hit, Request, Run, TagreeveRecord } from '../packages/core/src/records.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
export const demoDir = join(root, 'site/demo');
export const demoScenarios = ['undecided', 'accept', 'reject'] as const;
export type DemoScenario = (typeof demoScenarios)[number];

/** The `--seed` of every recorded run, so a test can rebuild each fake identity. `json` is the second reject run and `suite` the suite. */
export const demoSeeds = { undecided: 7101, accept: 7102, reject: 7103, json: 7104, suite: 7105 } as const;

const keptTypes = new Set<TagreeveRecord['type']>(['run', 'step', 'request', 'hit', 'consentEpoch', 'result', 'flag']);

const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

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

/** Every form of one seed's fake email and phone that must never be in a demo file. */
export function identityValues(seed: number): string[] {
  const { email, phone } = createIdentity(seed);
  const e164 = normalizePhone(phone);
  return [email, phone, e164, ...Object.values(hashEmail(email)), ...Object.values(hashPhone(phone))];
}

/**
 * What in `text` a demo file must not hold: a fake identity of one of the seeds, the seed field, a consent cookie
 * value, the old store host or any host that is not loopback.
 */
export function demoLeaks(text: string, seeds: readonly number[] = Object.values(demoSeeds)): string[] {
  const found = seeds.flatMap(identityValues).filter((v) => text.includes(v));
  for (const marker of ['identitySeed', 'pw_consent=', 'northwind.dk']) if (text.includes(marker)) found.push(marker);
  for (const [url] of text.matchAll(/\bhttps?:\/\/[^\s"'\\)]+/g)) if (!isLoopback(url)) found.push(url);
  return found;
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
      const scrubbed = toJsonl(scrubRecords(raw));
      const runId = /run_[0-9A-Z]+/.exec(path)![0];
      runIds.set(s, runId);
      await writeFile(join(clean, 'runs', `${runId}.jsonl`), scrubbed);
      written.set(`${s}.jsonl`, scrubbed);
      written.set(`${s}.txt`, result.stdout);
    }

    console.error('Recording reject --json');
    const json = check('json', await cli(['run', 'tagreeve/reject.yml', '--site', site.url, '--out', 'runs', '--seed', String(demoSeeds.json), '--json'], work));
    written.set('json.txt', json.stdout);

    const diff = check('diff', await cli(['diff', `runs/${runIds.get('reject')}.jsonl`, `runs/${runIds.get('accept')}.jsonl`], clean));
    written.set('diff.txt', diff.stdout);

    console.error('Recording the suite');
    const suite = check('suite', await cli(['suite', 'tagreeve/', '--site', site.url, '--out', 'runs', '--seed', String(demoSeeds.suite)], work));
    written.set('suite.txt', suite.stderr + suite.stdout);

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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  record().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
