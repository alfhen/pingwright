const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/**
 * Runs the handler once on SIGINT, SIGTERM or SIGHUP and waits for it. The signal is then sent again only when
 * no other listener is left, so the process still ends by the signal and another handler keeps its say.
 * The returned function removes the listeners.
 */
export function onTerminate(
  handler: (signal: NodeJS.Signals) => void | Promise<void>,
  raise: (signal: NodeJS.Signals) => void = (signal) => void process.kill(process.pid, signal),
): () => void {
  const listeners: [NodeJS.Signals, () => void][] = [];
  const remove = (): void => listeners.forEach(([signal, listener]) => process.off(signal, listener));
  for (const signal of SIGNALS) {
    const listener = (): void => {
      remove();
      void Promise.resolve()
        .then(() => handler(signal))
        .catch(() => undefined)
        .finally(() => {
          if (process.listenerCount(signal) === 0) raise(signal);
        });
    };
    listeners.push([signal, listener]);
    process.on(signal, listener);
  }
  return remove;
}
