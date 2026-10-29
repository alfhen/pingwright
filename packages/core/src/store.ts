import { createReadStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  Checkpoint,
  CollectorReport,
  ConsentEpoch,
  DataLayerEvent,
  Flag,
  Hit,
  InvalidReport,
  PingwrightRecord,
  Request,
  Response,
  Result,
  Run,
  Step,
  TagReport,
} from './records.ts';

export interface RunRecords {
  run: Run;
  steps: Step[];
  requests: Request[];
  responses: Response[];
  hits: Hit[];
  dataLayerEvents: DataLayerEvent[];
  tagReports: TagReport[];
  consentEpochs: ConsentEpoch[];
  checkpoints: Checkpoint[];
  results: Result[];
  flags: Flag[];
  collectorReports: CollectorReport[];
  invalidReports: InvalidReport[];
}

export function runFilePath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.jsonl`);
}

/** Streams records to one JSONL file. Nothing is held in memory; the Run is always the first line. */
export class RunWriter {
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(
    readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async create(runsDir: string, run: Run): Promise<RunWriter> {
    await mkdir(runsDir, { recursive: true });
    const path = runFilePath(runsDir, run.id);
    const handle = await open(path, 'wx');
    const writer = new RunWriter(path, handle);
    await writer.append(run);
    return writer;
  }

  append(record: PingwrightRecord): Promise<void> {
    if (this.closed) return Promise.reject(new Error('RunWriter is closed'));
    const line = JSON.stringify(record) + '\n';
    // Chained so lines never interleave; the caller still sees its own write's failure.
    const next = this.queue.then(() => this.handle.appendFile(line));
    this.queue = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.handle.close();
  }
}

function emptyRecords(run: Run): RunRecords {
  return {
    run,
    steps: [],
    requests: [],
    responses: [],
    hits: [],
    dataLayerEvents: [],
    tagReports: [],
    consentEpochs: [],
    checkpoints: [],
    results: [],
    flags: [],
    collectorReports: [],
    invalidReports: [],
  };
}

export async function readRun(path: string): Promise<RunRecords> {
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let out: RunRecords | undefined;
  let lineNo = 0;
  for await (const line of lines) {
    lineNo++;
    if (line.trim() === '') continue;
    let record: PingwrightRecord;
    try {
      record = JSON.parse(line) as PingwrightRecord;
    } catch {
      throw new Error(`${path}:${lineNo}: invalid JSON`);
    }
    if (!out) {
      if (record.type !== 'run') throw new Error(`${path}:${lineNo}: first record must be a run`);
      out = emptyRecords(record);
      continue;
    }
    switch (record.type) {
      case 'run':
        throw new Error(`${path}:${lineNo}: more than one run record`);
      case 'step':
        out.steps.push(record);
        break;
      case 'request':
        out.requests.push(record);
        break;
      case 'response':
        out.responses.push(record);
        break;
      case 'hit':
        out.hits.push(record);
        break;
      case 'dataLayerEvent':
        out.dataLayerEvents.push(record);
        break;
      case 'tagReport':
        out.tagReports.push(record);
        break;
      case 'consentEpoch':
        out.consentEpochs.push(record);
        break;
      case 'checkpoint':
        out.checkpoints.push(record);
        break;
      case 'result':
        out.results.push(record);
        break;
      case 'flag':
        out.flags.push(record);
        break;
      case 'collectorReport':
        out.collectorReports.push(record);
        break;
      case 'invalidReport':
        out.invalidReports.push(record);
        break;
      default:
        throw new Error(`${path}:${lineNo}: unknown record type ${String((record as { type: unknown }).type)}`);
    }
  }
  if (!out) throw new Error(`${path}: empty run file`);
  return out;
}
