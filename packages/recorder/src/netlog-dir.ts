import { rmSync } from 'node:fs';
import { onTerminate } from './terminate.ts';

/**
 * Removes the directory when the process exits or gets a termination signal, so a killed run leaves no net log
 * (it holds every URL of the session, unredacted). Returns the function that removes it now.
 */
export function watchNetLogDir(dir: string): () => void {
  const remove = (): void => {
    process.off('exit', remove);
    stopWatching();
    rmSync(dir, { recursive: true, force: true });
  };
  const stopWatching = onTerminate(remove);
  process.on('exit', remove);
  return remove;
}
