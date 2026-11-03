import { buildImage } from '@tagreeve/recorder';
import { helpText, parseCli, UsageError, usageHint } from './args.ts';
import { baselineCommand } from './baseline.ts';
import { diffCommand } from './diff.ts';
import { installBrowser } from './install-browser.ts';
import { reportCommand } from './report/index.ts';
import { runCommand, type Io } from './run.ts';
import { suiteCommand } from './suite.ts';
import { readVersion } from './version.ts';

const processIo: Io = {
  stdout: (text) => void process.stdout.write(text),
  stderr: (text) => void process.stderr.write(text),
};

async function buildCommand(io: Io): Promise<number> {
  const result = await buildImage({ version: readVersion() });
  switch (result.status) {
    case 'not-needed':
      io.stdout(`No build is needed on this machine. Pull Google's image and use it as it is:\n  ${result.image}\n`);
      return 0;
    case 'built':
      io.stdout(`Built ${result.tag}\nImage ID: ${result.imageId}\n`);
      return 0;
    case 'dockerMissing':
      io.stderr(`${result.message}\n`);
      return 2;
    case 'failed':
      io.stderr(`The image build failed.\n${result.message}\n`);
      return 2;
  }
}

/** Returns the exit code: 0 pass, 1 failed expectations, 2 usage or run error. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
  try {
    const command = parseCli(argv);
    switch (command.command) {
      case 'version':
        io.stdout(`${readVersion()}\n`);
        return 0;
      case 'help':
        io.stdout(helpText(command.topic));
        return 0;
      case 'install-browser':
        return (await installBrowser()) === 0 ? 0 : 2;
      case 'baseline':
        return await baselineCommand(command, io);
      case 'diff':
        return await diffCommand(command, io);
      case 'report':
        return await reportCommand(command, io);
      case 'suite':
        return await suiteCommand(command, io);
      case 'server-container':
        return await buildCommand(io);
      case 'run':
        return await runCommand(command, io);
    }
  } catch (error) {
    if (error instanceof UsageError) io.stderr(`${error.message}\n${usageHint(error.command)}\n`);
    else io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
