import { expect, it, vi } from 'vitest';

const captured: { onCapture?: (request: unknown, response: unknown) => void } = {};
const session = { containerExited: vi.fn(() => false), lastCallAt: () => 0, stopRecording: vi.fn(), stop: vi.fn(async () => undefined) };

vi.mock('./server-container/capture.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server-container/capture.ts')>()),
  startServerContainerSession: vi.fn(async (options: { onCapture: typeof captured.onCapture }) => {
    captured.onCapture = options.onCapture;
    return session;
  }),
  waitForQuiet: vi.fn(async () => undefined),
}));

const { Recorder } = await import('./recorder.ts');
type Internals = {
  startContainer(): Promise<void>;
  setHandoff(active: boolean): void;
  close(): Promise<unknown>;
  extraRequests: Array<{ url: string; postData: string | null; redacted?: string }>;
  containerFailure?: { errorClass: string };
};

function recorder(browser: unknown): Internals {
  const Ctor = Recorder as unknown as new (...args: unknown[]) => Internals;
  return new Ctor({ networkMode: 'server', serverContainer: { configSource: { kind: 'env' }, image: 'x' }, serverHosts: ['sgtm.example.com'] }, browser, { pages: () => [] });
}

it('a container call made during a handoff is stored redacted', async () => {
  const r = recorder({});
  await r.startContainer();
  r.setHandoff(true);
  captured.onCapture?.({ id: 'req_1', t: Date.now() + 1, url: 'https://unknown.example.com/p?card=4242', frameUrl: null, method: 'POST', headers: {}, postData: 'secret=1' }, {});
  expect(r.extraRequests[0]).toMatchObject({ url: expect.not.stringContaining('4242'), postData: expect.not.stringContaining('secret'), redacted: 'handoff' });
});

it('a container that exits during the quiet wait fails the run', async () => {
  session.containerExited.mockReturnValueOnce(false).mockReturnValue(true);
  const r = recorder({ close: vi.fn().mockRejectedValue(new Error('close failed')) });
  await r.startContainer();
  await expect(r.close()).rejects.toThrow('close failed');
  expect(r.containerFailure?.errorClass).toBe('exited');
});
