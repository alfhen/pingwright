import { createReadStream } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isId } from './ids.ts';
import { RECORD_SCHEMA_VERSION } from './records.ts';
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
  /** Line number of a cut-off last line that was dropped. Absent for a complete file. */
  truncatedAtLine?: number;
}

export function runFilePath(runsDir: string, runId: string): string {
  if (!isId(runId, 'run')) throw new Error(`invalid run id: ${JSON.stringify(runId)}`);
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
    await writer.append({ ...run, recordSchemaVersion: RECORD_SCHEMA_VERSION });
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

/** A record written again with the same id replaces the earlier one in place. */
function upsert<T extends { id: string }>(list: T[], record: T): void {
  const at = list.findIndex((r) => r.id === record.id);
  if (at < 0) list.push(record);
  else list[at] = record;
}

export interface ReadRunOptions {
  /** Receives problems that do not stop the read. Defaults to `console.warn`. */
  onWarning?: (message: string) => void;
}

export async function readRun(path: string, options: ReadRunOptions = {}): Promise<RunRecords> {
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let out: RunRecords | undefined;
  let lineNo = 0;
  let badLine = 0;
  for await (const line of lines) {
    lineNo++;
    if (line.trim() === '') continue;
    // Only the last non-empty line may be cut off by a crash; a bad line followed by more records is corruption.
    if (badLine) throw new Error(`${path}:${badLine}: invalid JSON`);
    let record: PingwrightRecord;
    try {
      record = JSON.parse(line) as PingwrightRecord;
    } catch {
      badLine = lineNo;
      continue;
    }
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new Error(`${path}:${lineNo}: record must be a JSON object`);
    }
    if (!out) {
      if (record.type !== 'run') throw new Error(`${path}:${lineNo}: first record must be a run`);
      out = emptyRecords(record);
      const version = record.recordSchemaVersion;
      if (version === undefined) {
        record.recordSchemaVersion = 0;
      } else if (!Number.isInteger(version) || version < 0) {
        throw new Error(`${path}:${lineNo}: recordSchemaVersion must be a non-negative integer`);
      } else if (version > RECORD_SCHEMA_VERSION) {
        warn(
          `${path}: record schema version ${version} is newer than this reader knows (${RECORD_SCHEMA_VERSION}); fields may be missing or misread`,
        );
      }
      continue;
    }
    switch (record.type) {
      case 'run':
        throw new Error(`${path}:${lineNo}: more than one run record`);
      case 'step':
        upsert(out.steps, record);
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
        upsert(out.consentEpochs, record);
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
  if (!out) throw new Error(badLine ? `${path}:${badLine}: invalid JSON` : `${path}: empty run file`);
  if (badLine) out.truncatedAtLine = badLine;
  return out;
}
