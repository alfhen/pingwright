#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createStandIn } from '../fixtures/site/src/stand-in-container.ts';
import type { StandInEnv } from '../fixtures/site/src/stand-in-container.ts';

// The runner stops a seam command with SIGKILL, so the stand-in runs in this process: a child
// would be orphaned. The tee file sits next to the CA file, which the runner always passes.
const target = join(dirname(process.env.NODE_EXTRA_CA_CERTS ?? ''), 'stand-in-stderr.log');
const write = process.stderr.write.bind(process.stderr) as (chunk: string | Uint8Array, ...rest: unknown[]) => boolean;
process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  appendFileSync(target, chunk);
  return write(chunk, ...rest);
}) as typeof process.stderr.write;

const standIn = createStandIn(process.env as StandInEnv);
await standIn.listen();
process.on('SIGTERM', () => void standIn.close().then(() => process.exit(0)));
