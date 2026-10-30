import type { Id } from './ids.ts';
import type { Identity } from './identity.ts';

export type ConsentValue = 'granted' | 'denied' | 'unknown';

export interface ConsentState {
  analytics: ConsentValue;
  ads: ConsentValue;
  adUserData: ConsentValue;
  adPersonalization: ConsentValue;
}

export interface HitConsent extends ConsentState {
  raw: Record<string, string>;
}

export type NetworkMode = 'stub' | 'server' | 'live';
export type RequestOutcome = 'passed' | 'stubbed' | 'failed';

export interface CaptureCoverage {
  page: boolean;
  iframe: boolean;
  dedicatedWorker: boolean;
  serviceWorker: 'chromium-only';
}

export interface Run {
  type: 'run';
  id: Id<'run'>;
  scenario: string;
  site: string;
  startedAt: number;
  pingwrightVersion: string;
  browser: { name: string; version: string };
  networkMode: NetworkMode;
  gtmOverride: string | null;
  containerVersions: Record<string, string>;
  identity: Identity | null;
  identitySeed?: number;
  coverage?: CaptureCoverage;
}

export interface Step {
  type: 'step';
  id: Id<'stp'>;
  runId: Id<'run'>;
  index: number;
  label: string;
  startedAt: number;
  endedAt: number | null;
  /** Why the step failed. Absent when it passed. */
  error?: string;
}

export interface Request {
  type: 'request';
  id: Id<'req'>;
  runId: Id<'run'>;
  stepId: Id<'stp'> | null;
  t: number;
  method: string;
  url: string;
  resourceType: string;
  frameUrl: string | null;
  initiator: string | null;
  headers: Record<string, string>;
  postData: string | null;
  outcome: RequestOutcome;
}

export interface Response {
  type: 'response';
  id: Id<'res'>;
  requestId: Id<'req'>;
  status: number;
  setCookieNames: string[];
}

export interface HashedId {
  present: boolean;
  /** Whether the hash matches the run's fake identity. Null when the run has no identity or the hash cannot be compared. */
  matchesIdentity: boolean | null;
}

export interface HitIds {
  user_id?: boolean;
  client_id?: boolean;
  /** Hashed identity fields by parameter name. */
  hashes?: Record<string, HashedId>;
  /** Other identifiers (click IDs, decoder-specific names) by presence. */
  [key: string]: boolean | Record<string, HashedId> | undefined;
}

export interface Hit {
  type: 'hit';
  id: Id<'hit'>;
  runId: Id<'run'>;
  stepId: Id<'stp'> | null;
  requestId: Id<'req'>;
  t: number;
  vendor: string;
  event: string | null;
  consent: HitConsent;
  ids: HitIds;
  page: string | null;
  transport: string;
  params: Record<string, string>;
}

export interface DataLayerEvent {
  type: 'dataLayerEvent';
  id: Id<'dle'>;
  runId: Id<'run'>;
  stepId: Id<'stp'> | null;
  t: number;
  event: string | null;
  gtmUniqueEventId: number | null;
  /** The pushed arguments, JSON-safe. A gtag() call is its argument list; any other push is `[item]`. */
  args: unknown[];
  isConsentCommand: boolean;
}

export interface TagStatus {
  id: string;
  name: string | null;
  status: string;
  executionTime: number | null;
}

export interface TagReport {
  type: 'tagReport';
  id: Id<'tag'>;
  runId: Id<'run'>;
  stepId: Id<'stp'> | null;
  container: string;
  side: 'web' | 'server';
  event: string;
  gtmUniqueEventId: number | null;
  tags: TagStatus[];
}

export interface ConsentEpoch {
  type: 'consentEpoch';
  id: Id<'cep'>;
  runId: Id<'run'>;
  startT: number;
  endT: number | null;
  source: string;
  /** What `epoch(label=<label>)` matches: `undecided` until the visitor answered, then the banner action's outcome, or `withdrawn`. */
  label: 'undecided' | 'granted' | 'denied' | 'mixed' | 'withdrawn';
  /** The Consent Mode state in the epoch, which may be mixed. In the undecided epoch it is the default. */
  state: ConsentState;
}

export interface CheckpointCookie {
  name: string;
  domain: string;
  expires: number | null;
  firstParty: boolean;
}

export interface Checkpoint {
  type: 'checkpoint';
  id: Id<'ckp'>;
  runId: Id<'run'>;
  stepId: Id<'stp'> | null;
  label: string;
  consentState: ConsentState | null;
  cookies: CheckpointCookie[];
}

export interface Result {
  type: 'result';
  id: Id<'rsl'>;
  runId: Id<'run'>;
  expectation: string;
  pass: boolean;
  evidence: string[];
  message?: string;
}

export type FlagKind =
  | 'unknownDestination'
  | 'firstPartySubdomain'
  | 'possibleRealData'
  | 'sandboxPageUrl'
  | 'stubBypass'
  | (string & {});

export interface Flag {
  type: 'flag';
  id: Id<'flg'>;
  runId: Id<'run'>;
  kind: FlagKind;
  recordIds: string[];
  detail: string;
}

/** A report that arrived at the collector origin and passed schema validation. */
export interface CollectorReport {
  type: 'collectorReport';
  id: Id<'rpt'>;
  runId: Id<'run'>;
  t: number;
  source: string;
  payload: unknown;
}

/** A report that arrived at the collector origin and failed validation. */
export interface InvalidReport {
  type: 'invalidReport';
  id: Id<'rpt'>;
  runId: Id<'run'>;
  t: number;
  error: string;
  body: string;
}

export type PingwrightRecord =
  | Run
  | Step
  | Request
  | Response
  | Hit
  | DataLayerEvent
  | TagReport
  | ConsentEpoch
  | Checkpoint
  | Result
  | Flag
  | CollectorReport
  | InvalidReport;

export type RecordType = PingwrightRecord['type'];
