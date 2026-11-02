import { spawn, type ChildProcess } from 'node:child_process';
import { astro, astroEnv, buildDocs, docsPort, docsUrl, root } from './docs-test-helpers.ts';

process.env.ASTRO_TELEMETRY_DISABLED = '1';

let preview: ChildProcess | undefined;

/** Builds the site once for every docs test file and serves it on one preview server. */
export async function setup(): Promise<void> {
  const result = buildDocs();
  if (result.status !== 0) throw new Error(`pnpm docs:build failed\n${result.stdout}\n${result.stderr}`);
  // --ignore-lock keeps the server in the foreground, so this process owns it and can stop it.
  preview = spawn(process.execPath, [astro, 'preview', '--root', 'site', '--port', String(docsPort), '--host', '127.0.0.1', '--ignore-lock'], {
    cwd: root,
    env: astroEnv,
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${docsUrl}/`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`astro preview did not start on port ${docsPort}`);
}

export function teardown(): void {
  preview?.kill();
}
