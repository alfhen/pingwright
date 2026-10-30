import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { expect, test, vi } from 'vitest';
import { readVersion } from '@pingwright/core';
import { COLLECTOR_ORIGIN, PINGWRIGHT_VERSION, Recorder } from './index.ts';

test('collector origin is the reserved .invalid host over https', () => {
  const url = new URL(COLLECTOR_ORIGIN);
  expect(url.hostname).toBe('collector.pingwright.invalid');
  expect(url.protocol).toBe('https:');
});

test('the run record version is the root package.json version', () => {
  expect(PINGWRIGHT_VERSION).toBe(readVersion());
});

test('netLog is refused in stub mode before a browser starts', async () => {
  await expect(Recorder.launch({ networkMode: 'stub', outDir: 'unused', site: 'http://localhost:1', netLog: true })).rejects.toThrow(/networkMode "live"/);
});

test('a failed browser launch removes the net log directory and its signal listeners', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'pw-launch-fail-'));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = parent;
  const names = ['exit', 'SIGINT', 'SIGTERM'];
  const listeners = names.map((name) => process.listenerCount(name));
  const launch = vi.spyOn(chromium, 'launch').mockRejectedValue(new Error('launch failed'));
  try {
    await expect(Recorder.launch({ networkMode: 'live', outDir: 'unused', site: 'http://localhost:1', netLog: true })).rejects.toThrow('launch failed');
    expect(launch).toHaveBeenCalledOnce();
    expect(await readdir(parent)).toEqual([]);
    expect(names.map((name) => process.listenerCount(name))).toEqual(listeners);
  } finally {
    launch.mockRestore();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(parent, { recursive: true, force: true });
  }
});
