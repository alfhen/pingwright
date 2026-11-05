import { describe, expect, it, vi } from 'vitest';
import { Recorder } from './recorder.js';

describe('Recorder.close', () => {
  it('removes the net log dir when browser.close throws', async () => {
    const remove = vi.fn();
    const browser = { close: vi.fn().mockRejectedValue(new Error('close failed')) };
    const Ctor = Recorder as unknown as new (...args: unknown[]) => Recorder;
    const recorder = new Ctor({ networkMode: 'live', netLog: true }, browser, {}, undefined, undefined, '/x/netlog.json', remove);
    await expect(recorder.close()).rejects.toThrow('close failed');
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('Recorder.close and late tag reports', () => {
  function recorderWith(reports: number) {
    const browser = { close: vi.fn().mockRejectedValue(new Error('stop here')) };
    const Ctor = Recorder as unknown as new (...args: unknown[]) => Recorder;
    const recorder = new Ctor({ networkMode: 'live' }, browser, {}, undefined, undefined, undefined, undefined);
    const inner = recorder as unknown as { tagReports: unknown[]; lastTagReportAt: number };
    for (let i = 0; i < reports; i += 1) inner.tagReports.push({});
    inner.lastTagReportAt = Date.now();
    return { browser, recorder, inner };
  }

  it('does not wait when the run got no report', async () => {
    const { browser, recorder } = recorderWith(0);
    await expect(recorder.close()).rejects.toThrow('stop here');
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it('waits until no report has arrived for 500 ms', async () => {
    vi.useFakeTimers();
    try {
      const { browser, recorder } = recorderWith(1);
      const closing = recorder.close().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(499);
      expect(browser.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2);
      expect(browser.close).toHaveBeenCalledTimes(1);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting after 2.5 s while reports keep arriving', async () => {
    vi.useFakeTimers();
    try {
      const { browser, recorder, inner } = recorderWith(1);
      const closing = recorder.close().catch(() => undefined);
      for (let i = 0; i < 24; i += 1) {
        await vi.advanceTimersByTimeAsync(100);
        inner.lastTagReportAt = Date.now();
      }
      expect(browser.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(browser.close).toHaveBeenCalledTimes(1);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
