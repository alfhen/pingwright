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

describe('Recorder.frameRef', () => {
  it('marks a detached child frame as not main', () => {
    const Ctor = Recorder as unknown as new (...args: unknown[]) => Recorder;
    const recorder = new Ctor({ networkMode: 'live' }, {}, {}, undefined, undefined, undefined, undefined);
    const frameRef = (recorder as unknown as { frameRef(frame: unknown): { main: boolean; n: number } }).frameRef.bind(recorder);
    const main = { parentFrame: () => null, page: () => page };
    const page = { mainFrame: () => main };
    const detached = { parentFrame: () => null, page: () => page };
    expect(frameRef(main).main).toBe(true);
    expect(frameRef(detached).main).toBe(false);
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

describe('Recorder.close and the dataLayer tally', () => {
  type Inner = {
    payloadCounts: { add(payload: unknown, frame: number, names: string[]): void };
    tallyDataLayers(): Promise<{ detail: string }[]>;
    waitForLateTagReports(): Promise<void>;
    flushUnloadQueues(): Promise<void>;
  };

  function build(frames: { evaluate: () => Promise<unknown> }[], networkMode = 'stub') {
    const browser = { close: vi.fn().mockRejectedValue(new Error('stop here')) };
    const context = { pages: () => [{ frames: () => frames }] };
    const Ctor = Recorder as unknown as new (...args: unknown[]) => Recorder;
    const recorder = new Ctor({ networkMode }, browser, context, undefined, undefined, undefined, undefined);
    return { browser, recorder, inner: recorder as unknown as Inner };
  }

  const answer = (length: number, posted: number) => ({ d: 'tok', arrays: [{ layer: 'dataLayer', a: 1, length, posted }] });

  it('ends the late tag report wait before the unload flush, the tally and the session stop', async () => {
    const order: string[] = [];
    const { browser, recorder, inner } = build([{ evaluate: async () => (order.push('tally'), answer(0, 0)) }]);
    inner.waitForLateTagReports = async () => void order.push('late');
    inner.flushUnloadQueues = async () => void order.push('flush');
    (recorder as unknown as { session: unknown }).session = {
      lastCallAt: () => 0,
      stopRecording: () => order.push('stop'),
      containerExited: () => false,
      stop: async () => undefined,
    };
    browser.close.mockImplementation(async () => {
      order.push('browser');
      throw new Error('stop here');
    });
    await expect(recorder.close()).rejects.toThrow();
    expect(order).toEqual(['late', 'flush', 'tally', 'stop', 'browser']);
  });

  it('waits for payloads the hook posted and then gives no flag', async () => {
    vi.useFakeTimers();
    try {
      const { inner } = build([{ evaluate: async () => answer(2, 2) }]);
      const flags = inner.tallyDataLayers();
      await vi.advanceTimersByTimeAsync(200);
      inner.payloadCounts.add({ d: 'tok', a: 1 }, 0, ['dataLayer']);
      inner.payloadCounts.add({ d: 'tok', a: 1 }, 0, ['dataLayer']);
      await vi.advanceTimersByTimeAsync(100);
      await expect(flags).resolves.toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compares as it is when payloads stay short after 1000 ms', async () => {
    vi.useFakeTimers();
    try {
      const { inner } = build([{ evaluate: async () => answer(2, 2) }]);
      const flags = inner.tallyDataLayers();
      let settled = false;
      void flags.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const result = await flags;
      expect(result).toHaveLength(1);
      expect(result[0]!.detail).toContain('holds 2 items, and 0 were recorded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a frame whose evaluate never resolves after 2000 ms and uses the others', async () => {
    vi.useFakeTimers();
    try {
      const { inner } = build([{ evaluate: () => new Promise(() => undefined) }, { evaluate: async () => answer(3, 0) }]);
      const flags = inner.tallyDataLayers();
      let settled = false;
      void flags.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1900);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      const result = await flags;
      expect(result).toHaveLength(1);
      expect(result[0]!.detail).toContain('Frame 1:');
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips a frame whose evaluate throws', async () => {
    const { inner } = build([{ evaluate: async () => Promise.reject(new Error('detached')) }]);
    await expect(inner.tallyDataLayers()).resolves.toEqual([]);
  });
});

describe('Recorder.close with a page that never answers', () => {
  it('stops waiting for the unload flush after the deadline', async () => {
    vi.useFakeTimers();
    try {
      const page = { evaluate: () => new Promise(() => undefined), frames: () => [] };
      const context = { pages: () => [page] };
      const browser = { close: vi.fn().mockRejectedValue(new Error('stop here')) };
      const Ctor = Recorder as unknown as new (...args: unknown[]) => Recorder;
      const recorder = new Ctor({ networkMode: 'stub' }, browser, context, undefined, undefined, undefined, undefined);
      const closing = recorder.close().catch(() => undefined);
      await vi.advanceTimersByTimeAsync(5000);
      expect(browser.close).toHaveBeenCalledTimes(1);
      await closing;
    } finally {
      vi.useRealTimers();
    }
  });
});
