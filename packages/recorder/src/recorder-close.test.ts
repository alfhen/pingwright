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
