import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCKERFILE } from '../packages/recorder/src/server-container/image.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const GOOGLE_FILE = /(^|\/)(server_bin\.js|health_checker_bin\.js|gtm-cloud-image[^/]*)$/;

describe('Google files stay out of the repository', () => {
  it('holds no file named server_bin.js, health_checker_bin.js or gtm-cloud-image*', () => {
    expect(tracked.filter((file) => GOOGLE_FILE.test(file))).toEqual([]);
  });

  it('has a Dockerfile that copies Google files only from the Google image stage', () => {
    for (const line of DOCKERFILE.split('\n').filter((l) => /^\s*(COPY|ADD)\b/.test(l))) {
      if (/server_bin\.js|health_checker_bin\.js|gtm-cloud-image/.test(line)) expect(line).toMatch(/--from=google\b/);
      expect(line).not.toMatch(/^\s*ADD\b/);
    }
  });

  it('has no Dockerfile in the repository', () => {
    expect(tracked.filter((file) => /(^|\/)Dockerfile[^/]*$/.test(file))).toEqual([]);
  });
});

describe('nothing pushes an image', () => {
  const sources = tracked.filter((file) => /^(\.github\/workflows\/.+\.ya?ml|scripts\/[^/]+\.(sh|ts|js|mjs)|package\.json)$/.test(file) && !file.endsWith('.test.ts'));
  const PUSH = /docker\s+(push|login)\b|docker\s+buildx\b[^\n]*--push|docker\s+(image\s+)?push\b|\bdocker\/login-action\b|\bdocker\/build-push-action\b/;

  it('finds the workflows and scripts it checks', () => {
    expect(sources.some((file) => file.startsWith('.github/workflows/'))).toBe(true);
  });

  it('has no docker push, docker login or buildx --push in a workflow or script', () => {
    const offenders = sources.filter((file) => PUSH.test(readFileSync(`${root}${file}`, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the pattern matches the commands it forbids', () => {
    for (const text of ['docker push x', 'docker login ghcr.io', 'docker buildx build --push .', 'uses: docker/login-action@v3', 'docker image push x']) {
      expect(PUSH.test(text)).toBe(true);
    }
    expect(PUSH.test('docker build -t x .')).toBe(false);
  });
});
