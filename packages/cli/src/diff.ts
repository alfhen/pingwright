import { readRun, type RunRecords } from '@pingwright/core';
import { diffRuns, type DiffKey, type DiffResult } from '@pingwright/expect';
import type { DiffArgs } from './args.ts';
import type { Io } from './run.ts';

type Tree = Map<string, Map<string, Map<string, string[]>>>;

function pathOf(page: string): string {
  try {
    return new URL(page).pathname;
  } catch {
    return page;
  }
}

function where(key: DiffKey, step: string, rawPage?: string | null): string {
  const raw = rawPage && key.page && pathOf(rawPage) !== key.page ? `, recorded as ${rawPage}` : '';
  const parts = [step && `step "${step}"`, key.page && `page ${key.page}${raw}`].filter(Boolean);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function add(tree: Tree, key: DiffKey, line: string): void {
  const event = key.event || '(no event)';
  const vendors = tree.get(key.epoch) ?? new Map();
  const events = vendors.get(key.vendor) ?? new Map();
  const lines = events.get(event) ?? [];
  lines.push(line);
  events.set(event, lines);
  vendors.set(key.vendor, events);
  tree.set(key.epoch, vendors);
}

export function formatDiff(result: DiffResult, a: string, b: string): string {
  const tree: Tree = new Map();
  for (const h of result.added) add(tree, h.key, `added${where(h.key, h.step, h.page)}: ${h.hitId}`);
  for (const h of result.removed) add(tree, h.key, `removed${where(h.key, h.step, h.page)}: ${h.hitId}`);
  for (const c of result.changed) {
    const changes = [...c.consent, ...c.ids].map((v) => `${v.field} ${v.a} -> ${v.b}`).join(', ');
    const moved = c.a.step === c.b.step ? '' : `, step "${c.a.step}" -> "${c.b.step}"`;
    add(tree, c.key, `changed${where(c.key, '')}${moved}: ${changes} (${c.a.hitId} -> ${c.b.hitId})`);
  }

  const out = [`Diff ${a} -> ${b}`];
  for (const warning of result.warnings) out.push(`Warning: ${warning}`);
  if (tree.size === 0 && result.flags.length === 0) out.push('No differences.');
  for (const [epoch, vendors] of [...tree].sort(([x], [y]) => x.localeCompare(y))) {
    out.push('', `Epoch ${epoch}`);
    for (const [vendor, events] of [...vendors].sort(([x], [y]) => x.localeCompare(y))) {
      out.push(`  ${vendor}`);
      for (const [event, lines] of [...events].sort(([x], [y]) => x.localeCompare(y))) {
        out.push(`    ${event}`);
        for (const line of lines) out.push(`      ${line}`);
      }
    }
  }
  if (result.flags.length) {
    out.push('', 'Flags');
    for (const f of result.flags) out.push(`  ${f.kind} ${f.host || '(no host)'}: ${f.a} -> ${f.b}`);
  }
  return `${out.join('\n')}\n`;
}

async function load(path: string): Promise<RunRecords> {
  try {
    return await readRun(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `Cannot read ${path}: ${message}`);
  }
}

/** Returns 0 once both files read. An unreadable or invalid file throws, and main turns that into exit 2. */
export async function diffCommand(args: DiffArgs, io: Io): Promise<number> {
  const [a, b] = await Promise.all([load(args.a), load(args.b)]);
  const result = diffRuns(a, b, { byPage: args.byPage });
  for (const [path, run] of [[args.a, a], [args.b, b]] as const) {
    if (run.truncatedAtLine) result.warnings.push(`${path}: truncated at line ${run.truncatedAtLine}; later records are missing from the diff`);
  }
  io.stdout(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatDiff(result, args.a, args.b));
  return 0;
}
