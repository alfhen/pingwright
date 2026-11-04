import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface OutDirInput {
  out: string | undefined;
  now: Date;
  label?: string;
  base?: string;
}

export function resolveOutDir({ out, now, label, base = 'tagreeve/runs' }: OutDirInput): string {
  if (out !== undefined) return out;
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return join(base, label === undefined ? date : `${date}-${label}`);
}

export const LABEL_PATTERN = /^[a-z0-9-]{1,40}$/;

export const OLD_RUNS_NOTICE = 'Note: records now go to tagreeve/runs/<date>/. ./runs/ holds older records; pass --out runs to keep using it.\n';

export async function oldRunsNotice(cwd: string): Promise<string | undefined> {
  let names: string[];
  try {
    names = await readdir(join(cwd, 'runs'));
  } catch {
    return undefined;
  }
  return names.some((n) => /^run_.*\.jsonl$/.test(n) || n.startsWith('suite_')) ? OLD_RUNS_NOTICE : undefined;
}
