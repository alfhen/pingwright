import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

/** Runs the installed Playwright's own CLI, so the browser revision matches the library. */
export function installBrowser(): Promise<number> {
  const cli = createRequire(import.meta.url).resolve('playwright/cli');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}
