import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Google's server container image. It is linux/amd64 only. */
export const GOOGLE_IMAGE = 'gcr.io/cloud-tagging-10302018/gtm-cloud-image@sha256:5ebac98d14121e2f9f64556648edf075d534826ca57dbbe47b60716690c97536';
export const NODE_BUILD_IMAGE = 'node:24@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413';
export const DISTROLESS_IMAGE = 'gcr.io/distroless/nodejs24-debian12@sha256:61f4f4341db81820c24ce771b83d202eb6452076f58628cd536cc7d94a10978b';

export const BASE_ENV = 'TAGREEVE_SERVER_CONTAINER_BASE';
export const IMAGE_REPOSITORY = 'tagreeve-sgtm';
export const NAME_PREFIX = 'tagreeve-sgtm-';
export const OWNER_PID_LABEL = 'tagreeve.owner.pid';
export const OWNER_HOST_LABEL = 'tagreeve.owner.host';

const DIGEST_REFERENCE = /^[a-z0-9][a-z0-9./_:-]*@sha256:[0-9a-f]{64}$/;

export function isDigestReference(reference: string): boolean {
  return DIGEST_REFERENCE.test(reference);
}

/** Written to a temp folder by `build`: an installed tagreeve has only `dist`, so it cannot be a file in the repository. */
export const DOCKERFILE = `ARG GOOGLE_IMAGE=${GOOGLE_IMAGE}
FROM --platform=linux/amd64 \${GOOGLE_IMAGE} AS google

FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /app
COPY --from=google /app/package.json /app/server_bin.js /app/health_checker_bin.js ./
RUN npm install --omit=dev

FROM ${DISTROLESS_IMAGE}
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
CMD ["server_bin.js"]
`;

/** Run as `node -e` in the relay container. RELAY_MAP is `listen=host:port,listen=host:port`. */
export const RELAY_SCRIPT = `const net = require('node:net');
for (const entry of String(process.env.RELAY_MAP || '').split(',')) {
  const [listen, target] = entry.split('=');
  const cut = target.lastIndexOf(':');
  const host = target.slice(0, cut);
  const port = Number(target.slice(cut + 1));
  net.createServer((client) => {
    const upstream = net.connect(port, host);
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => { client.destroy(); upstream.destroy(); };
    client.on('error', end);
    upstream.on('error', end);
    client.on('close', end);
    upstream.on('close', end);
  }).listen(Number(listen), '0.0.0.0');
}
`;

/** A host the run talks to anyway, so an open network sends nothing to a third party. */
export const PROBE_HOST = 'www.googletagmanager.com';

/**
 * Run as `node -e SCRIPT ADDRESS` on the internal network. ADDRESS is an IPv4 literal resolved
 * outside the container, so the connect check tests routing and not DNS.
 * Prints `{"connect":bool,"dns":bool}`.
 */
export const PROBE_SCRIPT = `const net = require('node:net');
const dns = require('node:dns');
const result = { connect: false, dns: false };
const connect = new Promise((resolve) => {
  const socket = net.connect({ host: process.argv[1], port: 443, timeout: 4000 });
  socket.on('connect', () => { result.connect = true; socket.destroy(); resolve(); });
  socket.on('timeout', () => { socket.destroy(); resolve(); });
  socket.on('error', () => resolve());
});
const lookup = new Promise((resolve) => {
  dns.lookup(${JSON.stringify(PROBE_HOST)}, (error) => { result.dns = !error; resolve(); });
});
Promise.all([connect, lookup]).then(() => { console.log(JSON.stringify(result)); process.exit(0); });
`;

export interface DockerResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The docker command was not found. */
  readonly missing: boolean;
}

export interface DockerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

/** Runs the `docker` command line with no shell. It never rejects. */
export function runDocker(args: readonly string[], options: DockerOptions = {}): Promise<DockerResult> {
  return new Promise((resolve) => {
    execFile('docker', [...args], { env: options.env ?? process.env, timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ code: 0, stdout, stderr, missing: false });
        return;
      }
      const code = (error as { code?: number | string }).code;
      resolve({ code: typeof code === 'number' ? code : 1, stdout, stderr, missing: code === 'ENOENT' });
    });
  });
}

export function imageTag(version: string): string {
  return `${IMAGE_REPOSITORY}:${version}`;
}

/** The Google image reference, or the override when it is a digest reference. */
export function baseImage(env: NodeJS.ProcessEnv): string {
  const override = env[BASE_ENV];
  if (override === undefined || override === '') return GOOGLE_IMAGE;
  if (!isDigestReference(override)) throw new Error(`${BASE_ENV} must be an image reference with a digest (name@sha256:<64 hex>).`);
  return override;
}

export type BuildResult =
  | { readonly status: 'built'; readonly tag: string; readonly imageId: string }
  | { readonly status: 'not-needed'; readonly image: string }
  | { readonly status: 'dockerMissing' }
  | { readonly status: 'failed'; readonly message: string };

export interface BuildOptions {
  readonly version: string;
  readonly arch?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly tempRoot?: string;
}

/** Builds the arm64 image on this machine. It never pushes. On amd64 no build is needed. */
export async function buildImage(options: BuildOptions): Promise<BuildResult> {
  const env = options.env ?? process.env;
  const base = baseImage(env);
  if ((options.arch ?? process.arch) !== 'arm64') return { status: 'not-needed', image: base };
  const tag = imageTag(options.version);
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'tagreeve-image-'));
  try {
    await writeFile(join(dir, 'Dockerfile'), DOCKERFILE);
    const built = await runDocker(['build', '--platform', 'linux/arm64', '--build-arg', `GOOGLE_IMAGE=${base}`, '--tag', tag, dir], { env });
    if (built.missing) return { status: 'dockerMissing' };
    if (built.code !== 0) return { status: 'failed', message: built.stderr.trim().split('\n').slice(-10).join('\n') };
    const inspected = await runDocker(['image', 'inspect', '--format', '{{.Id}}', tag], { env });
    return { status: 'built', tag, imageId: inspected.code === 0 ? inspected.stdout.trim() : tag };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
