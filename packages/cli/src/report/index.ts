import { readRun, type RunRecords } from '@pingwright/core';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ReportArgs } from '../args.ts';
import type { Io } from '../run.ts';
import { buildReportModel } from './model.ts';
import { renderReport } from './render.ts';

export * from './model.ts';
export { renderReport } from './render.ts';

async function load(path: string): Promise<RunRecords> {
  if ((await stat(path).catch(() => undefined))?.isDirectory()) throw new Error(`${path} is a directory. report reads one .jsonl run record.`);
  try {
    return await readRun(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.includes(path) ? message : `Cannot read ${path}: ${message}`);
  }
}

/** Returns 0 once the file is written. An unreadable or invalid record throws, and main turns that into exit 2. */
export async function reportCommand(args: ReportArgs, io: Io): Promise<number> {
  const records = await load(args.input);
  if (records.truncatedAtLine) io.stderr(`Warning: ${args.input} is truncated at line ${records.truncatedAtLine}; later records are missing from the report\n`);
  await mkdir(dirname(args.html), { recursive: true });
  await writeFile(args.html, renderReport(buildReportModel(records)));
  io.stdout(`Wrote ${args.html}\n`);
  return 0;
}
