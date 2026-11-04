import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What the fake `docker` answers. Each field is optional. */
export interface FakeDockerScript {
  version?: string;
  noImage?: boolean;
  buildFail?: boolean;
  /** The probe container's stdout. */
  probe?: string;
  /** Lines `docker logs --follow` prints. */
  logs?: string[];
  /** The logs command ends after printing, like a container that exited. */
  exited?: boolean;
  /** Output of `docker ps -a`. */
  ps?: string;
  /** Output of `docker network ls`. */
  networks?: string;
  gateway?: string;
  /** Tag lines `docker image ls` prints. */
  images?: string[];
  listFail?: boolean;
}

export interface FakeDockerCall {
  argv: string[];
  env: Record<string, string | undefined>;
  dockerfile?: string;
}

export interface FakeDocker {
  /** A PATH value that finds the fake `docker` and nothing else. */
  readonly path: string;
  readonly dir: string;
  env(script?: FakeDockerScript, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  calls(): FakeDockerCall[];
}

const SOURCE = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const cfg = JSON.parse(process.env.FAKE_DOCKER || '{}');
const entry = {
  argv: a,
  env: {
    CONTAINER_CONFIG: process.env.CONTAINER_CONFIG,
    HTTP_PROXY: process.env.HTTP_PROXY,
    TAGREEVE_SERVER_CONTAINER_CONFIG: process.env.TAGREEVE_SERVER_CONTAINER_CONFIG,
  },
};
const out = (text) => process.stdout.write(text + '\\n');
const [c, d] = a;
if (c === 'build') {
  entry.dockerfile = fs.readFileSync(a[a.length - 1] + '/Dockerfile', 'utf8');
}
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(entry) + '\\n');
if (c === 'version') out(cfg.version || '27.0.3');
else if (c === 'image' && d === 'inspect') {
  if (cfg.noImage) process.exit(1);
  out('sha256:' + 'a'.repeat(64));
} else if (c === 'image' && d === 'ls') {
  if (cfg.listFail) process.exit(1);
  for (const tag of cfg.images || []) out(tag);
} else if (c === 'build') {
  if (cfg.buildFail) {
    console.error('step failed');
    process.exit(1);
  }
  out('built');
} else if (c === 'network') {
  if (d === 'inspect') out(cfg.gateway || '172.17.0.1 ');
  else if (d === 'ls') out(cfg.networks || '');
  else if (d === 'create') out('network-id');
} else if (c === 'ps') out(cfg.ps || '');
else if (c === 'run') {
  if (a.includes('-d')) out('container-id');
  else out(cfg.probe || '{"connect":false,"dns":false}');
} else if (c === 'logs') {
  for (const line of cfg.logs || []) console.error(line);
  if (!cfg.exited) setInterval(() => {}, 1000);
}
`;

export function createFakeDocker(): FakeDocker {
  const dir = mkdtempSync(join(tmpdir(), 'tagreeve-fake-docker-'));
  const bin = join(dir, 'docker');
  const log = join(dir, 'calls.jsonl');
  writeFileSync(bin, SOURCE);
  chmodSync(bin, 0o755);
  writeFileSync(log, '');
  return {
    path: dir,
    dir,
    env: (script = {}, extra = {}) => ({ PATH: dir, FAKE_DOCKER: JSON.stringify(script), FAKE_DOCKER_LOG: log, ...extra }),
    calls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeDockerCall),
  };
}
