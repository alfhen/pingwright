import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeDocker } from './fake-docker.test-helper.ts';
import { BASE_ENV, DISTROLESS_IMAGE, DOCKERFILE, GOOGLE_IMAGE, NODE_BUILD_IMAGE, baseImage, buildImage, imageTag, isDigestReference } from './image.ts';

const DIGEST = `gcr.io/example/image@sha256:${'b'.repeat(64)}`;
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('pinned images', () => {
  it('are digests, not tags', () => {
    for (const image of [GOOGLE_IMAGE, NODE_BUILD_IMAGE, DISTROLESS_IMAGE]) {
      expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
      expect(isDigestReference(image)).toBe(true);
    }
  });

  it('rejects a tag as the base override', () => {
    expect(isDigestReference('gcr.io/example/image:stable')).toBe(false);
    expect(() => baseImage({ [BASE_ENV]: 'gcr.io/example/image:stable' })).toThrow(BASE_ENV);
    expect(baseImage({ [BASE_ENV]: DIGEST })).toBe(DIGEST);
    expect(baseImage({})).toBe(GOOGLE_IMAGE);
  });
});

describe('Dockerfile', () => {
  it('takes Google files from the Google image, not from the build context', () => {
    const copies = DOCKERFILE.split('\n').filter((line) => line.startsWith('COPY'));
    expect(copies.length).toBeGreaterThan(0);
    for (const line of copies) expect(line).toContain('--from=');
    expect(DOCKERFILE).toContain('ARG GOOGLE_IMAGE=');
    expect(DOCKERFILE).not.toMatch(/docker push|--push/);
  });
});

describe('buildImage', () => {
  it('writes the Dockerfile into a temp context and builds for arm64 with the version tag', async () => {
    const fake = createFakeDocker();
    cleanup.push(fake.dir);
    const tempRoot = mkdtempSync(join(tmpdir(), 'tagreeve-build-root-'));
    cleanup.push(tempRoot);
    const result = await buildImage({ version: '1.2.3', arch: 'arm64', env: fake.env(), tempRoot });
    expect(result).toEqual({ status: 'built', tag: imageTag('1.2.3'), imageId: `sha256:${'a'.repeat(64)}` });
    const build = fake.calls().find((call) => call.argv[0] === 'build');
    expect(build?.dockerfile).toBe(DOCKERFILE);
    expect(build?.argv).toEqual(['build', '--platform', 'linux/arm64', '--build-arg', `GOOGLE_IMAGE=${GOOGLE_IMAGE}`, '--tag', 'tagreeve-sgtm:1.2.3', expect.any(String)]);
    expect(readdirSync(tempRoot)).toEqual([]);
    expect(fake.calls().some((call) => call.argv.some((arg) => arg === 'push' || arg === 'login' || arg === '--push'))).toBe(false);
  });

  it('passes the base override as a build argument', async () => {
    const fake = createFakeDocker();
    cleanup.push(fake.dir);
    await buildImage({ version: '1.0.0', arch: 'arm64', env: fake.env({}, { [BASE_ENV]: DIGEST }) });
    expect(fake.calls().find((call) => call.argv[0] === 'build')?.argv).toContain(`GOOGLE_IMAGE=${DIGEST}`);
  });

  it('needs no build on amd64 and runs no docker command', async () => {
    const fake = createFakeDocker();
    cleanup.push(fake.dir);
    expect(await buildImage({ version: '1.0.0', arch: 'x64', env: fake.env() })).toEqual({ status: 'not-needed', image: GOOGLE_IMAGE });
    expect(fake.calls()).toEqual([]);
  });

  it('reports a missing docker command', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tagreeve-no-docker-'));
    cleanup.push(empty);
    expect(await buildImage({ version: '1.0.0', arch: 'arm64', env: { PATH: empty } })).toEqual({ status: 'dockerMissing' });
  });

  it('reports a failed build with the last lines of its error', async () => {
    const fake = createFakeDocker();
    cleanup.push(fake.dir);
    const result = await buildImage({ version: '1.0.0', arch: 'arm64', env: fake.env({ buildFail: true }) });
    expect(result).toEqual({ status: 'failed', message: 'step failed' });
  });
});
