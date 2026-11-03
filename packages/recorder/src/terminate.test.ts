import { afterEach, expect, test, vi } from 'vitest';
import { onTerminate } from './terminate.ts';

let remove: (() => void) | undefined;
afterEach(() => remove?.());

test('the handler finishes before the signal is sent again', async () => {
  const order: string[] = [];
  const raised = new Promise<NodeJS.Signals>((resolve) => {
    remove = onTerminate(
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push('cleaned');
      },
      (signal) => {
        order.push('raised');
        resolve(signal);
      },
    );
  });
  process.emit('SIGINT');
  expect(await raised).toBe('SIGINT');
  expect(order).toEqual(['cleaned', 'raised']);
});

test('the signal is not sent again while another listener is left', async () => {
  const other = vi.fn();
  process.on('SIGTERM', other);
  const raise = vi.fn();
  const handled = new Promise<void>((resolve) => {
    remove = onTerminate(() => resolve(), raise);
  });
  try {
    process.emit('SIGTERM');
    await handled;
    await new Promise((r) => setTimeout(r, 10));
    expect(raise).not.toHaveBeenCalled();
  } finally {
    process.off('SIGTERM', other);
  }
});

test('the handler runs once', async () => {
  const handler = vi.fn();
  remove = onTerminate(handler, () => undefined);
  process.emit('SIGINT');
  process.emit('SIGINT');
  await new Promise((r) => setTimeout(r, 10));
  expect(handler).toHaveBeenCalledTimes(1);
});
