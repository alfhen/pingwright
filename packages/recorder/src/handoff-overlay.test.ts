import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { boundedWake, HandoffGate, handoffOverlayScript, waitForHandoff } from './handoff-overlay.ts';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const never = (_text: string, signal: AbortSignal) => new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));

test('the Done button ends the wait and aborts the terminal prompt', async () => {
  const gate = new HandoffGate();
  let aborted = false;
  const resolver = (text: string, signal: AbortSignal) => never(text, signal).then(() => void (aborted = true));
  const wait = waitForHandoff({ text: 'Pay', gate, resolver, print: () => {} });
  expect(gate.state()).toEqual({ waiting: true, text: 'Pay' });
  expect(gate.done(gate.nonce)).toBe(true);
  await wait;
  await Promise.resolve();
  expect(aborted).toBe(true);
  expect(gate.state().waiting).toBe(false);
});

test('Enter in the terminal ends the wait', async () => {
  const gate = new HandoffGate();
  await waitForHandoff({ text: 'Pay', gate, resolver: () => Promise.resolve(), print: () => {} });
  expect(gate.state().waiting).toBe(false);
});

test('when both end the wait, it ends once and a later Done is refused', async () => {
  const gate = new HandoffGate();
  let resolveTerminal = () => {};
  const resolver = () => new Promise<void>((resolve) => (resolveTerminal = resolve));
  const wait = waitForHandoff({ text: 'Pay', gate, resolver, print: () => {} });
  gate.done(gate.nonce);
  resolveTerminal();
  await wait;
  expect(gate.done(gate.nonce)).toBe(false);
});

test('a wrong, missing or non-string nonce does not end the wait', async () => {
  const gate = new HandoffGate();
  let ended = false;
  const wait = waitForHandoff({ text: 'Pay', gate, resolver: never, print: () => {} }).then(() => void (ended = true));
  for (const bad of ['nope', undefined, null, 1, {}]) expect(gate.done(bad)).toBe(false);
  await Promise.resolve();
  expect(ended).toBe(false);
  gate.done(gate.nonce);
  await wait;
});

test('a reminder prints every 60 seconds until the wait ends', async () => {
  const gate = new HandoffGate();
  const printed: string[] = [];
  const wait = waitForHandoff({ text: 'Pay the order', gate, resolver: never, print: (t) => printed.push(t) });
  await vi.advanceTimersByTimeAsync(59_000);
  expect(printed).toEqual([]);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(printed).toEqual(['Still waiting for the handoff: Pay the order']);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(printed).toHaveLength(3);
  gate.done(gate.nonce);
  await wait;
  await vi.advanceTimersByTimeAsync(180_000);
  expect(printed).toHaveLength(3);
});

test('the overlay script runs only in the top frame and makes no request', () => {
  const script = handoffOverlayScript('nonce-1');
  expect(script).toContain('window.top !== window');
  expect(script).toContain("mode: 'closed'");
  expect(script).toContain('isTrusted');
  expect(script).not.toMatch(/fetch\(|XMLHttpRequest|sendBeacon|new Image|http:|https:/);
});

test('the overlay captures its show-time accessors before page code and reads isTrusted from an instance', () => {
  const script = handoffOverlayScript('nonce-1');
  const captureAt = script.indexOf('setter(Node.prototype');
  expect(captureAt).toBeGreaterThan(-1);
  expect(captureAt).toBeLessThan(script.indexOf('const build'));
  expect(script).toContain("uncurry(Object.getOwnPropertyDescriptor(new Event('x'), 'isTrusted').get)");
  expect(script).not.toContain("Event.prototype, 'isTrusted'");
  expect(script).not.toMatch(/\.call\(/);
  expect(script).not.toMatch(/\.textContent =|\.title =|\.style\.|\.documentElement|\.parentNode|\.remove\(\)/);
  expect(script).toContain('calc(100vw - 32px)');
});

test('a throw from the isTrusted getter reads as untrusted', () => {
  const script = handoffOverlayScript('nonce-1');
  const trusted = script.match(/const trusted = [^\n]+/)![0];
  const getter = function (this: { real?: boolean }) {
    if (!this?.real) throw new TypeError('Illegal invocation');
    return true;
  };
  const run = new Function('trustedOf', `${trusted}; return trusted;`)((event: unknown) => getter.call(event as { real?: boolean })) as (event: unknown) => boolean;
  expect(run({ isTrusted: true })).toBe(false);
  expect(run({ real: true })).toBe(true);
});

test('a wake that never answers does not hold up Enter', async () => {
  const gate = new HandoffGate();
  await waitForHandoff({ text: 'Pay', gate, resolver: () => Promise.resolve(), print: () => {}, wake: () => new Promise<void>(() => {}) });
  expect(gate.state().waiting).toBe(false);
});

test('a wake that never answers does not hold up Done', async () => {
  const gate = new HandoffGate();
  const wait = waitForHandoff({ text: 'Pay', gate, resolver: never, print: () => {}, wake: () => new Promise<void>(() => {}) });
  expect(gate.done(gate.nonce)).toBe(true);
  await wait;
});

test('a wake that fails does not end the wait', async () => {
  const gate = new HandoffGate();
  let ended = false;
  const wait = waitForHandoff({ text: 'Pay', gate, resolver: never, print: () => {}, wake: () => Promise.reject(new Error('no page')) }).then(() => void (ended = true));
  await Promise.resolve();
  await Promise.resolve();
  expect(ended).toBe(false);
  gate.done(gate.nonce);
  await wait;
});

test('a wake that never settles is dropped after the limit and leaves no timer', async () => {
  let settled = false;
  void boundedWake(() => new Promise<void>(() => {}), 2000).then(() => void (settled = true));
  await vi.advanceTimersByTimeAsync(1999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a wake that settles or fails clears its limit timer', async () => {
  await boundedWake(() => Promise.resolve());
  await boundedWake(() => Promise.reject(new Error('no page')));
  await boundedWake(() => {
    throw new Error('sync');
  });
  expect(vi.getTimerCount()).toBe(0);
});

interface Deferred {
  resolve: (state: { waiting: boolean; text: string }) => void;
}

function runOverlay() {
  const listeners = new Map<string, () => void>();
  const intervals = new Map<number, () => void>();
  let nextInterval = 1;
  const pending: Deferred[] = [];
  const removed = { count: 0 };
  const stateFn = () => new Promise((resolve) => pending.push({ resolve }));
  const element = () => ({ style: {}, attachShadow: () => ({}), append() {}, remove() {} });
  class FakeNode {}
  class FakeElement extends FakeNode {
    append(...children: { parent?: unknown }[]) {
      for (const child of children) child.parent = this;
    }
    remove(this: { parent?: unknown }) {
      removed.count++;
      this.parent = null;
    }
    getBoundingClientRect() {
      return {};
    }
    setPointerCapture() {}
  }
  class FakeEvent {
    constructor() {
      Object.defineProperty(this, 'isTrusted', { get: () => true });
    }
    get target() {
      return null;
    }
    stopPropagation() {}
  }
  Object.defineProperty(FakeNode.prototype, 'textContent', { set() {}, configurable: true });
  Object.defineProperty(FakeNode.prototype, 'parentNode', {
    get(this: { parent?: unknown }) {
      return this.parent ?? null;
    },
    configurable: true,
  });
  class FakeHTMLElement extends FakeElement {}
  Object.defineProperty(FakeHTMLElement.prototype, 'title', { set() {}, configurable: true });
  Object.defineProperty(FakeHTMLElement.prototype, 'style', { get: () => ({ setProperty() {} }), configurable: true });
  class FakeDocument {}
  const documentRoot = new FakeElement();
  Object.defineProperty(FakeDocument.prototype, 'documentElement', { get: () => documentRoot, configurable: true });
  class FakeFragment {
    append() {}
  }
  class FakeMouse extends FakeEvent {}
  Object.defineProperty(FakeMouse.prototype, 'clientX', { get: () => 0 });
  Object.defineProperty(FakeMouse.prototype, 'clientY', { get: () => 0 });
  class FakePointer extends FakeMouse {}
  Object.defineProperty(FakePointer.prototype, 'pointerId', { get: () => 0 });
  class FakeTarget {
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, fn);
    }
  }
  const window: Record<string, unknown> = {
    __pwHandoffState: stateFn,
    __pwHandoffDone: () => Promise.resolve(),
  };
  window.top = window;
  const sandbox = {
    window,
    document: { createElement: element },
    EventTarget: FakeTarget,
    Node: FakeNode,
    Element: FakeElement,
    HTMLElement: FakeHTMLElement,
    Document: FakeDocument,
    DocumentFragment: FakeFragment,
    Event: FakeEvent,
    MouseEvent: FakeMouse,
    PointerEvent: FakePointer,
    CSSStyleDeclaration: class {
      setProperty() {}
    },
    CSSStyleSheet: class {
      replaceSync() {}
    },
    innerWidth: 800,
    innerHeight: 600,
    setInterval: (fn: () => void) => {
      const id = nextInterval++;
      intervals.set(id, fn);
      return id;
    },
    clearInterval: (id: number) => void intervals.delete(id),
  };
  sandbox.window.addEventListener = (type: string, fn: () => void) => listeners.set(type, fn);
  runInNewContext(handoffOverlayScript('nonce-1'), sandbox);
  return {
    pending,
    intervals,
    removed,
    wake: () => listeners.get('pingwright-handoff-wake')!(),
    tick: () => [...intervals.values()].forEach((fn) => fn()),
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

test('a stale not-waiting answer does not stop the polling that a wake started', async () => {
  const overlay = runOverlay();
  expect(overlay.intervals.size).toBe(1);
  expect(overlay.pending).toHaveLength(1);
  overlay.pending[0]!.resolve({ waiting: false, text: '' });
  await flush();
  expect(overlay.intervals.size).toBe(0);

  overlay.wake();
  expect(overlay.intervals.size).toBe(1);
  expect(overlay.pending).toHaveLength(2);
  overlay.wake();
  expect(overlay.pending).toHaveLength(3);
  overlay.pending[1]!.resolve({ waiting: false, text: '' });
  await flush();
  expect(overlay.intervals.size).toBe(1);
  overlay.tick();
  expect(overlay.pending).toHaveLength(4);
  overlay.pending[2]!.resolve({ waiting: false, text: '' });
  overlay.pending[3]!.resolve({ waiting: false, text: '' });
  await flush();
  expect(overlay.intervals.size).toBe(0);
});

test('a stale not-waiting answer does not remove the pill a newer answer showed', async () => {
  const overlay = runOverlay();
  overlay.pending[0]!.resolve({ waiting: true, text: 'Log in' });
  await flush();
  overlay.pending[0]!.resolve({ waiting: false, text: '' });
  overlay.tick();
  overlay.wake();
  expect(overlay.pending).toHaveLength(3);
  overlay.pending[2]!.resolve({ waiting: true, text: 'Pay' });
  await flush();
  overlay.pending[1]!.resolve({ waiting: false, text: '' });
  await flush();
  expect(overlay.removed.count).toBe(0);
  expect(overlay.intervals.size).toBe(1);
});

test('a not-waiting answer that is current removes the pill and stops the polling', async () => {
  const overlay = runOverlay();
  overlay.pending[0]!.resolve({ waiting: true, text: 'Log in' });
  await flush();
  overlay.tick();
  overlay.pending[1]!.resolve({ waiting: false, text: '' });
  await flush();
  expect(overlay.removed.count).toBe(1);
  expect(overlay.intervals.size).toBe(0);
});
