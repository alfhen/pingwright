import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRun, type Hit, type RunRecords } from '../../../packages/core/src/index.ts';

export const STORY_HOST = 'staging.northwind.example';
export const USER_PROMPT = `Meta numbers fell off a cliff after Tuesday's publish, and Legal says Meta fires before people answer the cookie banner. Can you check ${STORY_HOST}?`;

/** The demo's window for hits, in ms of the demo clock `t`: the first recorded hit lands at the start, the last at the end. */
export const HIT_WINDOW = [1900, 4700] as const;

/** When the banner answer lands on the demo clock. The button shows pressed for the 300 ms before it. */
export const ANSWER_AT = 3300;
const PRESS_MS = 300;

export type ScenarioKey = 'undecided' | 'reject' | 'accept';
export type Tone = 'fg' | 'dim' | 'faint' | 'mint' | 'fail' | 'warn';

export interface Line {
  text: string;
  tone: Tone;
}

export interface DemoHit {
  id: string;
  at: number;
  vendor: string;
  event: string;
  tag: string;
  /** The hit is evidence of a failed rule or check. */
  fail: boolean;
}

export interface DemoScenario {
  key: ScenarioKey;
  label: string;
  /** The `tagreeve run` command line the agent runs, without the `$ `. */
  command: string;
  plan: string;
  reply: string[];
  verdict: { title: string; body: string; exit: string };
  exitCode: number;
  /** The banner answer and when it lands on the demo clock. Null when the visitor never answers. */
  answer: { action: 'accept' | 'reject'; at: number; epoch: string } | null;
  hits: DemoHit[];
  /** The page path shown in the URL bar from `at` on. */
  pages: { at: number; path: string }[];
  /** The tool output the agent sees: the head and tail of the stdout and the exit code. */
  toolOut: Line[];
}

export interface DemoCommand {
  key: 'run' | 'diff' | 'suite' | 'json';
  name: string;
  desc: string;
  lines: Line[];
}

export interface DemoData {
  storyHost: string;
  userPrompt: string;
  scenarios: DemoScenario[];
  commands: DemoCommand[];
}

const SCENARIOS: { key: ScenarioKey; label: string; action: 'accept' | 'reject' | null }[] = [
  { key: 'undecided', label: 'ignores banner', action: null },
  { key: 'reject', label: 'rejects', action: 'reject' },
  { key: 'accept', label: 'accepts', action: 'accept' },
];

interface Reply {
  plan: string;
  verdict: { title: string; body: string };
  reply: string[];
}

/** Reads `## plan`, `## verdict` and `## reply`. Paragraphs split on blank lines; lines inside a paragraph keep their breaks. */
export function parseReply(markdown: string, name: string): Reply {
  const sections = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of markdown.split('\n')) {
    const heading = /^## (\w+)\s*$/.exec(line);
    if (heading) sections.set(heading[1]!, (current = []));
    else current?.push(line);
  }
  const paragraphs = (section: string) => {
    const lines = sections.get(section);
    if (!lines) throw new Error(`${name}: missing "## ${section}"`);
    return lines
      .join('\n')
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);
  };
  const [plan] = paragraphs('plan');
  const [title, body] = paragraphs('verdict');
  if (!plan || !title || !body) throw new Error(`${name}: the plan needs one paragraph and the verdict a title and a body`);
  return { plan, verdict: { title, body }, reply: paragraphs('reply') };
}

const EVIDENCE = /hit_(?:…|\.\.\.)?[0-9A-Z]+/g;
// A number not glued to a word, as in GA4 or x2.
const NUMBER = /(?<![\w.…])\d+(?:\.\d+)?(?!\w)/g;
const LIST_MARKER = /^\d+\. /gm;

/** The results that fail the run: failed rules and checks, except those with severity warn. */
export function failedResults(records: RunRecords): RunRecords['results'] {
  return records.results.filter((r) => !r.pass && r.severity !== 'warn');
}

/** The numbers a reply may use: rule messages, evidence counts, hit counts, the number of failed rules and the exit code. */
export function recordNumbers(records: RunRecords, exitCode: number): Set<string> {
  const numbers = new Set<string>([String(exitCode)]);
  const failed = failedResults(records);
  numbers.add(String(failed.length));
  numbers.add(String(records.results.length));
  for (const r of records.results) {
    numbers.add(String(r.evidence.length));
    for (const n of (r.message ?? '').match(/\d+(?:\.\d+)?/g) ?? []) numbers.add(n);
  }
  numbers.add(String(records.hits.length));
  const byVendor = new Map<string, number>();
  const byEvent = new Map<string, number>();
  for (const h of records.hits) {
    byVendor.set(h.vendor, (byVendor.get(h.vendor) ?? 0) + 1);
    const key = `${h.vendor} ${h.event}`;
    byEvent.set(key, (byEvent.get(key) ?? 0) + 1);
  }
  for (const n of [...byVendor.values(), ...byEvent.values()]) numbers.add(String(n));
  return numbers;
}

/**
 * Throws, naming the value, when the reply uses a number that the record does not hold, or an evidence ID that is not
 * the evidence of a failed rule in the record. A shortened ID (`hit_…6CA`) must match exactly one such ID.
 */
export function checkReply(text: string, records: RunRecords, exitCode: number, name: string): void {
  // Hit IDs in one run are monotonic, so an edited ID usually names another real hit: only rule evidence counts.
  const ids = [...failedEvidence(records)];
  for (const token of text.match(EVIDENCE) ?? []) {
    const tail = token.replace(/^hit_(?:…|\.\.\.)?/, '');
    const matches = token.startsWith('hit_…') || token.startsWith('hit_...') ? ids.filter((id) => id.endsWith(tail)) : ids.filter((id) => id === token);
    if (matches.length !== 1) {
      throw new Error(`${name}: evidence ID ${token} ${matches.length ? 'matches more than one' : 'is not the evidence of a failed rule'} in the record of ${records.run.id}`);
    }
  }
  const numbers = recordNumbers(records, exitCode);
  for (const n of text.replace(EVIDENCE, '').replace(LIST_MARKER, '').match(NUMBER) ?? []) {
    if (!numbers.has(n)) throw new Error(`${name}: the number ${n} is not in the record of ${records.run.id}`);
  }
}

/** The exit code of a recorded `tagreeve run`, from the "Result:" line it printed: 0 for pass, 1 for fail. */
export function recordedExitCode(stdout: string, name: string): 0 | 1 {
  const result = /^Result: (pass|fail)\b/m.exec(stdout)?.[1];
  if (!result) throw new Error(`${name}: no "Result: pass" or "Result: fail" line`);
  return result === 'pass' ? 0 : 1;
}

function epochAt(records: RunRecords, t: number) {
  const epochs = [...records.consentEpochs].sort((a, b) => a.startT - b.startT);
  return epochs.filter((e) => e.startT <= t).at(-1) ?? epochs[0];
}

function failedEvidence(records: RunRecords): Set<string> {
  return new Set(failedResults(records).flatMap((r) => r.evidence));
}

function tagOf(records: RunRecords, hit: Hit, fail: boolean): string {
  const label = epochAt(records, hit.t)?.label ?? 'undecided';
  if (label === 'undecided') return fail ? 'before consent' : 'undecided';
  if (label === 'denied') return fail ? 'after reject' : hit.consent.raw.gcs ? 'gcs denied' : 'denied';
  return label;
}

const answerEpoch = (records: RunRecords) => [...records.consentEpochs].sort((a, b) => a.startT - b.startT)[1];

function scale([a, b]: readonly [number, number], [from, to]: readonly [number, number]): (t: number) => number {
  return (t) => Math.round(b > a ? from + ((t - a) / (b - a)) * (to - from) : from);
}

/**
 * Maps a time on the record's clock to the demo clock, so the first hit lands at the start of the window and the last
 * at its end. When the visitor answers the banner, the hits before the answer end where the press starts, and the
 * answer lands at `ANSWER_AT`, so the hits after it get the rest of the window.
 */
export function demoClock(records: RunRecords): (t: number) => number {
  const times = records.hits.map((h) => h.t);
  const first = Math.min(...times);
  const last = Math.max(...times);
  const answer = answerEpoch(records)?.startT;
  if (answer === undefined) return scale([first, last], HIT_WINDOW);
  const lastBefore = Math.max(first, ...times.filter((t) => t < answer));
  const before = scale([first, lastBefore], [HIT_WINDOW[0], ANSWER_AT - PRESS_MS]);
  const after = scale([answer, last], [ANSWER_AT, HIT_WINDOW[1]]);
  return (t) => (t < answer ? before(t) : after(t));
}

/** The record's hits, in record order, with their time on the demo clock and their tag. */
export function demoHits(records: RunRecords): DemoHit[] {
  const clock = demoClock(records);
  const failed = failedEvidence(records);
  return records.hits.map((h) => {
    const fail = failed.has(h.id);
    return { id: h.id, at: clock(h.t), vendor: h.vendor, event: h.event ?? '(no event)', tag: tagOf(records, h, fail), fail };
  });
}

function demoPages(records: RunRecords): DemoScenario['pages'] {
  const clock = demoClock(records);
  const pages: DemoScenario['pages'] = [];
  for (const h of [...records.hits].sort((a, b) => a.t - b.t)) {
    if (!h.page || h.page.includes('/web-pixels@')) continue;
    const path = new URL(h.page).pathname;
    if (pages.at(-1)?.path !== path) pages.push({ at: clock(h.t), path });
  }
  return pages;
}

function toneOf(line: string): Tone {
  if (/^ {2}PASS /.test(line) || line.startsWith('Result: pass')) return 'mint';
  if (/^ {2}FAIL /.test(line) || line.startsWith('Result: fail')) return 'fail';
  if (/^ {2}WARN /.test(line)) return 'warn';
  if (/^ {7}\S/.test(line) || line.startsWith('Record: ') || line.startsWith('Running ')) return 'dim';
  return 'fg';
}

const linesOf = (text: string): string[] => text.replace(/\n$/, '').split('\n');
const toLines = (texts: string[]): Line[] => texts.map((text) => ({ text, tone: toneOf(text) }));

export function shortenOutput(stdout: string, exitCode: number): Line[] {
  const lines = linesOf(stdout);
  const exit: Line = { text: `exit ${exitCode}`, tone: 'faint' };
  if (lines.length <= 5) return [...toLines(lines), exit];
  return [
    ...lines.slice(0, 3).map((text) => ({ text, tone: 'dim' as Tone })),
    { text: `… +${lines.length - 5} lines`, tone: 'faint' },
    ...lines.slice(-2).map((text) => ({ text, tone: toneOf(text) === 'fail' ? ('fail' as Tone) : ('dim' as Tone) })),
    exit,
  ];
}

/** The recorded `--json` result. Throws when it is not the first result of the record it was taken from. */
function jsonLines(json: string, records: RunRecords, name: string): Line[] {
  const recorded = JSON.parse(json) as { expectation?: string; evidence?: string[] };
  const first = records.results[0];
  if (!first || recorded.expectation !== first.expectation || JSON.stringify(recorded.evidence) !== JSON.stringify(first.evidence)) {
    throw new Error(`${name}: not the first result of the record of ${records.run.id}`);
  }
  return linesOf(json).map((text) => ({ text, tone: /^ {2}"pass": false/.test(text) ? 'fail' : 'fg' }));
}

function diffLines(stdout: string): Line[] {
  return linesOf(stdout).map((text) => ({ text, tone: /^ +(added|removed|changed)\b/.test(text) ? 'mint' : 'fg' }));
}

const runCommand = (file: string) => `tagreeve run tagreeve/${file} --site https://${STORY_HOST}`;

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

interface Recorded {
  records: RunRecords;
  stdout: string;
}

async function loadRecorded(dir: string, key: ScenarioKey): Promise<Recorded> {
  const records = await readRun(join(dir, `${key}.jsonl`));
  if (records.run.site !== `https://${STORY_HOST}`) throw new Error(`site/demo/${key}.jsonl: the run's site is ${records.run.site}, not https://${STORY_HOST}`);
  return { records, stdout: read(dir, `${key}.txt`) };
}

function scenarioOf(dir: string, { records, stdout }: Recorded, key: ScenarioKey, label: string, action: 'accept' | 'reject' | null): DemoScenario {
  const replyName = `site/demo/${key}.reply.md`;
  const reply = parseReply(read(dir, `${key}.reply.md`), replyName);
  const exitCode = recordedExitCode(stdout, `site/demo/${key}.txt`);
  checkReply([reply.plan, reply.verdict.title, reply.verdict.body, ...reply.reply].join('\n'), records, exitCode, replyName);
  const clock = demoClock(records);
  const answered = answerEpoch(records);
  if (Boolean(action) !== Boolean(answered)) throw new Error(`site/demo/${key}.jsonl: the consent epochs do not fit a visitor who ${label}`);
  return {
    key,
    label,
    command: runCommand(`${key}.yml`),
    plan: reply.plan,
    reply: reply.reply,
    verdict: { ...reply.verdict, exit: `exit ${exitCode}` },
    exitCode,
    answer: action && answered ? { action, at: clock(answered.startT), epoch: answered.label } : null,
    hits: demoHits(records),
    pages: demoPages(records),
    toolOut: shortenOutput(stdout, exitCode),
  };
}

/** Builds the demo from the recorded files in `dir` (`site/demo`). Throws when a reply does not match its record. */
export async function loadDemo(dir: string): Promise<DemoData> {
  const recorded = new Map(await Promise.all(SCENARIOS.map(async (s) => [s.key, await loadRecorded(dir, s.key)] as const)));
  const scenarios = SCENARIOS.map((s) => scenarioOf(dir, recorded.get(s.key)!, s.key, s.label, s.action));
  const reject = recorded.get('reject')!;
  const diff = read(dir, 'diff.txt');
  const [, a, b] = /^Diff (\S+) -> (\S+)$/m.exec(diff) ?? [];
  if (!a || !b) throw new Error('site/demo/diff.txt: no "Diff a -> b" line');
  const site = `--site https://${STORY_HOST}`;
  const command = (text: string): Line => ({ text: `$ ${text}`, tone: 'dim' });
  const commands: DemoCommand[] = [
    { key: 'run', name: 'tagreeve run', desc: 'Play one scenario. Exit 0, 1 or 2.', lines: [command(runCommand('reject.yml')), ...toLines(linesOf(reject.stdout))] },
    { key: 'diff', name: 'tagreeve diff', desc: 'Compare two records, e.g. published vs. workspace.', lines: [command(`tagreeve diff ${a} ${b}`), ...diffLines(diff)] },
    { key: 'suite', name: 'tagreeve suite', desc: 'A folder of scenarios × several GTM builds, for CI.', lines: [command(`tagreeve suite tagreeve/ ${site}`), ...toLines(linesOf(read(dir, 'suite.txt')))] },
    { key: 'json', name: '--json', desc: 'Stable JSON with evidence IDs, for agents and scripts.', lines: [command(`tagreeve run tagreeve/reject.yml --site … --json | jq '.results[0]'`), ...jsonLines(read(dir, 'reject.json'), reject.records, 'site/demo/reject.json')] },
  ];
  return { storyHost: STORY_HOST, userPrompt: USER_PROMPT, scenarios, commands };
}
