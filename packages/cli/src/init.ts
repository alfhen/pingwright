import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Io } from './run.ts';
import { gitIgnoreStatus } from './git-ignore.ts';

export const IGNORE_LINE = '/tagreeve/runs/';
const FOLDERS = ['tagreeve/scenarios', 'tagreeve/baselines'];

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureIgnoreLine(cwd: string): Promise<string> {
  const file = join(cwd, '.gitignore');
  let current: string | undefined;
  try {
    current = await readFile(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current?.split(/\r?\n/).some((line) => line.trim() === IGNORE_LINE)) return `Skipped .gitignore: it already has ${IGNORE_LINE}`;
  if ((await gitIgnoreStatus(join(cwd, 'tagreeve/runs'))) === 'ignored') return 'Skipped .gitignore: git already ignores tagreeve/runs/';
  const prefix = current === undefined || current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${prefix}${IGNORE_LINE}\n`);
  return current === undefined ? `Created .gitignore with ${IGNORE_LINE}` : `Added ${IGNORE_LINE} to .gitignore`;
}

export async function initCommand(io: Io, cwd: string = process.cwd()): Promise<number> {
  const lines: string[] = [];
  for (const folder of FOLDERS) {
    if (await exists(join(cwd, folder))) {
      lines.push(`Skipped ${folder}/: it exists`);
      continue;
    }
    await mkdir(join(cwd, folder), { recursive: true });
    lines.push(`Created ${folder}/`);
  }
  lines.push(await ensureIgnoreLine(cwd));
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
