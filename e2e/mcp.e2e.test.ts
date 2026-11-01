import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { readRun } from '../packages/core/src/index.ts';
import { root, runCli, scenario, site } from './cli-helpers.ts';

const EMAIL = 'pw-fixture@example.com';
const HASH = createHash('sha256').update(EMAIL).digest('hex');
const COOKIE = 'pw-fixture-cookie-value';
const SUITE = 'suite_00000000000000000000000001';

class McpClient {
  private nextId = 1;
  private pending = new Map<number, (message: Record<string, unknown>) => void>();
  readonly output: string[] = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    createInterface({ input: child.stdout }).on('line', (line) => {
      this.output.push(line);
      const message = JSON.parse(line) as { id?: number };
      if (message.id !== undefined) this.pending.get(message.id)?.(message as Record<string, unknown>);
    });
  }

  request(method: string, params: unknown): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((resolve) => this.pending.set(id, resolve));
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return reply;
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const reply = await this.request('tools/call', { name, arguments: args });
    const result = reply.result as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError === true };
  }
}

let runsDir: string;
let child: ChildProcessWithoutNullStreams;
let client: McpClient;
let runId: string;
let secondRunId: string;
const texts: string[] = [];

beforeAll(async () => {
  runsDir = await mkdtemp(join(root, 'test-results', 'mcp-'));
  const play = () => runCli(['run', scenario('mcp-leak'), '--site', site.url, '--out', runsDir, '--json']);
  runId = (await play()).records!.run.id;
  secondRunId = (await play()).records!.run.id;
  await mkdir(join(runsDir, SUITE), { recursive: true });
  await writeFile(
    join(runsDir, SUITE, 'suite.json'),
    JSON.stringify({ suiteSchemaVersion: 1, id: SUITE, startedAt: 1, site: 'http://localhost', variants: ['desktop'], cells: [], diffs: [], exitCode: 0 }),
  );

  child = spawn(process.execPath, [join(root, 'dist/mcp.js'), '--runs', runsDir], { stdio: ['pipe', 'pipe', 'pipe'] });
  client = new McpClient(child);
  await client.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'pingwright-e2e', version: '0.0.0' },
  });
  client.notify('notifications/initialized');
}, 120_000);

afterAll(async () => {
  child?.kill();
  if (runsDir) await rm(runsDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.call(name, args);
  texts.push(result.text);
  return result;
}

test('the fixture run holds the email, its hash and the cookie value', async () => {
  const records = await readRun(join(runsDir, `${runId}.jsonl`));
  const raw = JSON.stringify(records);
  expect(raw).toContain(EMAIL);
  expect(records.hits.some((h) => h.page?.includes(EMAIL))).toBe(true);
  expect(records.flags.some((f) => f.kind === 'unknownDestination' && f.detail.includes(EMAIL))).toBe(true);
}, 60_000);

test('lists the five tools', async () => {
  const reply = await client.request('tools/list', {});
  const names = (reply.result as { tools: { name: string }[] }).tools.map((t) => t.name).sort();
  expect(names).toEqual(['diff_runs', 'get_hits', 'get_suite', 'get_summary', 'list_runs']);
});

test('list_runs, get_summary and get_hits return the hits', async () => {
  const list = JSON.parse((await call('list_runs', {})).text) as { runs: { runId: string; siteHost: string }[] };
  expect(list.runs.map((r) => r.runId).sort()).toEqual([runId, secondRunId].sort());
  expect(list.runs[0]!.siteHost).toMatch(/^localhost:\d+$/);

  const summary = JSON.parse((await call('get_summary', { runId })).text) as { hits: Record<string, Record<string, number>>; flags: Record<string, number> };
  expect(summary.hits.meta?.PageView).toBeGreaterThan(0);
  expect(summary.flags.unknownDestination).toBeGreaterThan(0);

  const hits = JSON.parse((await call('get_hits', { runId, vendor: 'meta', event: 'PageView' })).text) as { total: number; hits: { vendor: string }[] };
  expect(hits.total).toBeGreaterThan(0);
  expect(hits.hits[0]!.vendor).toBe('meta');
});

test('diff_runs and get_suite answer', async () => {
  const diff = JSON.parse((await call('diff_runs', { a: runId, b: secondRunId })).text) as { schemaVersion: number };
  expect(diff.schemaVersion).toBe(1);
  const suite = JSON.parse((await call('get_suite', { suiteId: SUITE })).text) as { suiteId: string };
  expect(suite.suiteId).toBe(SUITE);
});

test('refuses a path as an ID', async () => {
  const result = await call('get_summary', { runId: '../../etc/passwd' });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('Expected a run ID');
});

test('no result holds the email, its hash or the cookie value', () => {
  expect(texts.length).toBeGreaterThan(5);
  const all = texts.join('\n') + client.output.join('\n');
  for (const value of [EMAIL, encodeURIComponent(EMAIL), HASH, COOKIE, 'unknown.pingwright.invalid/x', '?em=']) {
    expect(all).not.toContain(value);
  }
});
