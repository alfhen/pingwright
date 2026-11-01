import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { readVersion } from '@pingwright/core';
import { diffRunsTool, getHits, getSuite, getSummary, listRuns, ToolError } from './tools.ts';

type Handler<A> = (runsDir: string, args: A) => Promise<unknown>;

export function createServer(runsDir: string): McpServer {
  const server = new McpServer({ name: 'pingwright', version: readVersion() });

  const register = <S extends z.ZodRawShape>(name: string, description: string, shape: S, handler: Handler<z.infer<z.ZodObject<S>>>) => {
    server.registerTool(
      name,
      { description, inputSchema: z.object(shape), annotations: { readOnlyHint: true, openWorldHint: false } },
      async (args: z.infer<z.ZodObject<S>>) => {
        try {
          return { content: [{ type: 'text' as const, text: JSON.stringify(await handler(runsDir, args)) }] };
        } catch (error) {
          if (!(error instanceof ToolError)) throw error;
          return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
        }
      },
    );
  };

  register('list_runs', 'List recorded runs, newest first: run ID, scenario name, site host, start time, variant and ok.', {
    limit: z.number().int().optional().describe('At most this many runs (default 100, maximum 1000).'),
  }, listRuns);
  register('get_summary', 'Summary of one run: hit counts by vendor and event, consent epochs, flag kinds with counts, and each expectation result with its severity. No URLs, messages or recorded values.', {
    runId: z.string().describe('A run ID from list_runs.'),
  }, getSummary);
  register('get_hits', 'Decoded vendor hits of one run: ID, vendor, event, consent epoch label, consent state, which identifiers are present, parameter names and step label. No parameter values.', {
    runId: z.string(),
    vendor: z.string().optional(),
    event: z.string().optional(),
    epoch: z.string().optional().describe('A consent epoch label such as undecided, granted, denied or withdrawn.'),
    limit: z.number().int().optional().describe('At most this many hits (default 100, maximum 1000).'),
  }, getHits);
  register('diff_runs', 'Compare two runs: added, removed and changed hits per consent epoch, vendor and event, and flag count changes. No page URLs.', {
    a: z.string().describe('The earlier run ID.'),
    b: z.string().describe('The later run ID.'),
  }, diffRunsTool);
  register('get_suite', 'The manifest of one suite: cells with status and run ID, and the diffs between variants.', {
    suiteId: z.string().describe('A suite ID such as the directory name under the runs directory.'),
  }, getSuite);

  return server;
}
