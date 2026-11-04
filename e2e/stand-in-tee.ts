#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const standIn = fileURLToPath(new URL('../fixtures/site/src/stand-in-container.ts', import.meta.url));

// The runner passes the stand-in a fixed set of variables, so the tee file sits next to the CA file.
const target = join(dirname(process.env.NODE_EXTRA_CA_CERTS ?? ''), 'stand-in-stderr.log');
const child = spawn(standIn, [], { shell: false, stdio: ['ignore', 'inherit', 'pipe'], env: process.env });
child.stderr.on('data', (chunk: Buffer) => {
  appendFileSync(target, chunk);
  process.stderr.write(chunk);
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
