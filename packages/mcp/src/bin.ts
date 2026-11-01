import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readVersion } from '@pingwright/core';
import { createServer } from './server.ts';

const USAGE = `Usage: pingwright-mcp --runs <dir>

Serves read-only MCP tools over stdio for the run records in <dir>.
`;

function parseArgs(argv: string[]): { runs: string } | { exit: number; text: string } {
  if (argv.includes('--help') || argv.includes('-h')) return { exit: 0, text: USAGE };
  if (argv.includes('--version')) return { exit: 0, text: `${readVersion()}\n` };
  const at = argv.indexOf('--runs');
  const value = at >= 0 ? argv[at + 1] : undefined;
  if (!value || argv.length !== 2) return { exit: 2, text: USAGE };
  return { runs: resolve(value) };
}

const parsed = parseArgs(process.argv.slice(2));
if ('exit' in parsed) {
  (parsed.exit === 0 ? process.stdout : process.stderr).write(parsed.text);
  process.exitCode = parsed.exit;
} else if (!(await stat(parsed.runs).then((s) => s.isDirectory(), () => false))) {
  process.stderr.write(`Expected --runs to be an existing directory, found ${parsed.runs}.\n`);
  process.exitCode = 2;
} else {
  await createServer(parsed.runs).connect(new StdioServerTransport());
}
