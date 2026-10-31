import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HandoffGate, handoffOverlayScript, waitForHandoff } from './handoff-overlay.ts';

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
