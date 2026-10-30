import { rmSync } from 'node:fs';

/**
 * Removes the directory when the process exits or gets SIGINT or SIGTERM, so a killed run leaves no net log
 * (it holds every URL of the session, unredacted). Returns the function that removes it now.
 */
export function watchNetLogDir(dir: string): () => void {
  const remove = (): void => {
    process.off('exit', remove);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    remove();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  process.on('exit', remove);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return remove;
}
