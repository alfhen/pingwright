import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const GIT_TIMEOUT_MS = 5000;
const PROBE_FILE = 'probe.jsonl';

async function nearestExistingDir(path: string): Promise<string> {
  let dir = resolve(path);
  for (;;) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function checkIgnoreExit(cwd: string, path: string): Promise<number | undefined> {
  return new Promise((resolveCode) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-C', cwd, 'check-ignore', '-q', path], { timeout: GIT_TIMEOUT_MS }, (error) => {
      if (!error) return resolveCode(0);
      const code = (error as { code?: unknown }).code;
      resolveCode(typeof code === 'number' ? code : undefined);
    });
  });
}

export type IgnoreStatus = 'ignored' | 'unignored' | 'unknown';

/** `unknown` covers no git, no work tree and any other failure. */
export async function gitIgnoreStatus(path: string): Promise<IgnoreStatus> {
  const absolute = resolve(path);
  const existing = await nearestExistingDir(absolute);
  // Probe a file inside the folder: "dir/**" and "*.jsonl" rules match the files, not the folder, and a "dir/" rule matches a folder that does not exist yet.
  const code = await checkIgnoreExit(existing, join(absolute, PROBE_FILE));
  return code === 0 ? 'ignored' : code === 1 ? 'unignored' : 'unknown';
}

export async function isUnignoredInWorkTree(path: string): Promise<boolean> {
  return (await gitIgnoreStatus(path)) === 'unignored';
}

export async function warnIfNotIgnored(folder: string, stderr: (text: string) => void): Promise<void> {
  if (await isUnignoredInWorkTree(folder)) {
    stderr(`Warning: ${folder} is not in .gitignore. Records hold full request bodies; do not commit them. Run tagreeve init or add the folder to .gitignore.\n`);
  }
}
