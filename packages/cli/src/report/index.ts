import { readRun, type RunRecords } from '@pingwright/core';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ReportArgs } from '../args.ts';
import type { Io } from '../run.ts';
import { buildReportModel } from './model.ts';
import { renderReport } from './render.ts';
import { buildSuiteModel, loadSuite, renderSuiteReport } from './suite.ts';

export * from './model.ts';
export { renderReport } from './render.ts';
export * from './suite.ts';

async function load(path: string): Promise<RunRecords> {
  try {
    return await readRun(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `Cannot read ${path}: ${message}`);
  }
}

async function isSameFile(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  const [sa, sb] = await Promise.all([stat(a).catch(() => undefined), stat(b).catch(() => undefined)]);
  return sa !== undefined && sb !== undefined && sa.dev === sb.dev && sa.ino === sb.ino;
}

async function refuseOverwrite(html: string, inputs: string[]): Promise<void> {
  for (const input of inputs) if (await isSameFile(input, html)) throw new Error(`--html must not be ${input}`);
}

async function write(args: ReportArgs, html: string, io: Io): Promise<number> {
  await mkdir(dirname(args.html), { recursive: true });
  await writeFile(args.html, html);
  io.stdout(`Wrote ${args.html}\n`);
  return 0;
}

/** Returns 0 once the file is written. An unreadable or invalid input throws, and main turns that into exit 2. */
export async function reportCommand(args: ReportArgs, io: Io): Promise<number> {
  if ((await stat(args.input).catch(() => undefined))?.isDirectory()) {
    const { manifest, records } = await loadSuite(args.input);
    const recordFiles = manifest.cells.flatMap((c) => (typeof c.record === 'string' ? [join(args.input, c.record)] : []));
    await refuseOverwrite(args.html, [join(args.input, 'suite.json'), ...recordFiles]);
    return write(args, renderSuiteReport(buildSuiteModel(manifest, records)), io);
  }
  await refuseOverwrite(args.html, [args.input]);
  const records = await load(args.input);
  if (records.truncatedAtLine) io.stderr(`Warning: ${args.input} is truncated at line ${records.truncatedAtLine}; later records are missing from the report\n`);
  return write(args, renderReport(buildReportModel(records)), io);
}
