import { parseCli, RUN_USAGE, UsageError, USAGE } from './args.ts';
import { installBrowser } from './install-browser.ts';
import { runCommand, type Io } from './run.ts';
import { readVersion } from './version.ts';

const processIo: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

/** Returns the exit code: 0 pass, 1 failed expectations, 2 usage or run error. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
  try {
    const command = parseCli(argv);
    switch (command.command) {
      case 'version':
        io.stdout(`${readVersion()}\n`);
        return 0;
      case 'help':
        io.stdout(command.topic === 'run' ? RUN_USAGE : USAGE);
        return 0;
      case 'install-browser':
        return (await installBrowser()) === 0 ? 0 : 2;
      case 'run':
        return await runCommand(command, io);
    }
  } catch (error) {
    if (error instanceof UsageError) io.stderr(`${error.message}\n\n${USAGE}`);
    else io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
