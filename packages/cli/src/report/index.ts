import { readRun, type RunRecords } from '@pingwright/core';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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

async function write(args: ReportArgs, html: string, io: Io): Promise<number> {
  await mkdir(dirname(args.html), { recursive: true });
  await writeFile(args.html, html);
  io.stdout(`Wrote ${args.html}\n`);
  return 0;
}

/** Returns 0 once the file is written. An unreadable or invalid input throws, and main turns that into exit 2. */
export async function reportCommand(args: ReportArgs, io: Io): Promise<number> {
  if (resolve(args.input) === resolve(args.html)) throw new Error('--html must not be the input file');
  if ((await stat(args.input).catch(() => undefined))?.isDirectory()) {
    const { manifest, records } = await loadSuite(args.input);
    return write(args, renderSuiteReport(buildSuiteModel(manifest, records)), io);
  }
  const records = await load(args.input);
  if (records.truncatedAtLine) io.stderr(`Warning: ${args.input} is truncated at line ${records.truncatedAtLine}; later records are missing from the report\n`);
  return write(args, renderReport(buildReportModel(records)), io);
}
