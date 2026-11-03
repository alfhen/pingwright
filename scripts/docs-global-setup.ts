import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { astro, astroEnv, buildDocs, dist, root } from './docs-build.ts';

process.env.ASTRO_TELEMETRY_DISABLED = '1';

let preview: ChildProcess | undefined;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Builds the site once for every docs test file and serves it on one preview server. */
export async function setup(project: TestProject): Promise<void> {
  const result = buildDocs();
  if (result.status !== 0) throw new Error(`pnpm docs:build failed\n${result.stdout}\n${result.stderr}`);
  // Other checkouts on this machine run docs tests at the same time. When the port is taken, astro preview
  // moves to the next one without saying so, and the tests then load the other checkout's site.
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  // --ignore-lock keeps the server in the foreground, so this process owns it and can stop it.
  preview = spawn(process.execPath, [astro, 'preview', '--root', 'site', '--port', String(port), '--host', '127.0.0.1', '--ignore-lock'], {
    cwd: root,
    env: astroEnv,
    stdio: 'ignore',
  });
  const home = readFileSync(join(dist, 'index.html'), 'utf8');
  for (let i = 0; i < 100 && preview.exitCode === null; i++) {
    const body = await fetch(`${url}/`).then((r) => (r.ok ? r.text() : undefined), () => undefined);
    if (body === home) {
      project.provide('docsUrl', url);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`astro preview did not serve ${dist} on ${url}`);
}

export function teardown(): void {
  preview?.kill();
}
