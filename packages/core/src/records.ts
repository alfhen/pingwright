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

/**
 * Version 1 is the 0.2.0 record shape. Version 2 adds `Hit.fields`, `Hit.fieldsComplete` and `Hit.idFields`,
 * which a version 1 hit does not have. Version 3 adds `Request.captured: 'serverContainer'`, `Hit.via`,
 * `Run.serverContainer` and `Run.testServerContainer`. Version 4 adds `Run.label` and `Run.store`, and a
 * `Hit.via` with `by: 'clientId'` may be `exact`. A record with no version is version 0.
 */
export const RECORD_SCHEMA_VERSION = 4;

export type ServerContainerErrorClass = 'dockerMissing' | 'imageMissing' | 'configRejected' | 'egressOpen' | 'exited' | 'notReady';

/** What the recording proxy forwarded to Google, by class. */
export interface ServerContainerPassThrough {
  serverjs: number;
  config: number;
  destination: number;
}

/** Counts and the image only. Never the config, a container ID or a host name of the container. */
export interface ServerContainerRecord {
  /** The image reference, with its digest or ID. */
  image: string;
  startedAt: number;
  /** Calls the container made that were recorded. */
  requests: number;
  passThrough: ServerContainerPassThrough;
  /** `407` answers the proxy sent. */
  refused: number;
  /** Hits decoded from container calls that have no `via`. */
  unlinked: number;
  /** Set when the container did not start or died. */
  error?: ServerContainerErrorClass;
}

export interface GtmOverrideTag {
  id: string;
  name: string | null;
}

export interface GtmOverrideApplied {
  way: 'direct' | 'loader' | 'replace';
  /** Set for way 'loader'. */
  loader?: 'stape';
  /** The request the page made. Never the preview URL, which carries the auth value. */
  url: string;
  /** The preview fetch's status, or 0 when the fetch failed. */
  status: number;
  /** What the way gives up. Set for 'loader' and 'replace'. */
  loses?: string;
}

export interface GtmOverrideRecord {
  container: string;
  gtmPreview: string;
  gtmAuth: '[redacted]';
  /** Stored for later use, not evaluated. */
  expectedTags: GtmOverrideTag[];
  applied: GtmOverrideApplied[];
}

export interface Run {
  type: 'run';
  id: Id<'run'>;
  /** Stamped by `RunWriter`. Absent only in files written before 0.2, which `readRun` reports as 0. */
  recordSchemaVersion?: number;
  scenario: string;
  site: string;
  startedAt: number;
  pingwrightVersion: string;
  browser: { name: string; version: string };
  networkMode: NetworkMode;
  gtmOverride: GtmOverrideRecord | null;
  /** Set when `TAGREEVE_TEST_GTM_ORIGIN` replaced the GTM origin in gtm.js fetches. */
  testGtmOrigin?: string;
  containerVersions: Record<string, string>;
  identity: Identity | null;
  identitySeed?: number;
  coverage?: CaptureCoverage;
  /** The grace window the consent epochs were judged with: the scenario's `graceWindow`, or the default. */
  graceWindowMs?: number;
  /** The suite variant this run belongs to. A name, never a file path. */
  variant?: string;
  /** From `--label`: 1 to 40 lowercase letters, digits or hyphens. */
  label?: string;
  /** The store name of a `suite --stores` cell. */
  store?: string;
  /** The viewport that was asked for. Absent means the Playwright default. */
  viewport?: { width: number; height: number };
  /** Set when `TAGREEVE_TEST_LOOPBACK_IS_HOSTED` made the `fill`, `select` and `evaluate` guards treat loopback hosts as hosted. */
  testLoopbackHosted?: true;
  /** Set when `--server-container` ran the user's server container. */
  serverContainer?: ServerContainerRecord;
  /** Set when the stand-in container of `TAGREEVE_TEST_SERVER_CONTAINER_CMD` ran in place of a real one. */
  testServerContainer?: true;
}

export interface Step {
  type: 'step';
  id: Id<'stp'>;
  runId: Id<'run'>;
  index: number;
  label: string;
  /** Index of the selector in an `any` locator that the step used. */
  locator?: number;
  startedAt: number;
  endedAt: number | null;
  /** What ended a `handoff` step. Absent on other steps and on older records. */
  handoffEnd?: 'done' | 'enter' | 'until' | 'timeout';
  /** Selectors of `optional` fill entries whose field was not on the page. Never values. */
  skippedFields?: string[];
  /** Set on a `payment` step once its first key is typed. `testMode` says whether the user declared the host or the page showed the marker. Never the values. */
  payment?: { provider: string; mode: 'test'; testMode?: 'declared' | 'marker' };
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
  /** Playwright's errorText for a failed request, such as `net::ERR_ABORTED`. */
  failure?: string;
  /** Set when `postData` and the URL's query values were replaced because a person was typing during a handoff. */
  redacted?: 'handoff';
  /**
   * Absent when a browser hook saw the request. `netlog`: found in Chromium's net log only, so `postData` is null.
   * `serverContainer`: a call the server container made, seen by the recording proxy. It was answered locally.
   */
  captured?: 'netlog' | 'serverContainer';
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

export interface HitVia {
  /** The browser hit this hit most likely came from. */
  hitId: Id<'hit'>;
  by: 'eventId' | 'clientId' | 'identity';
  /**
   * `exact` is proven: by event ID and event name, or by client ID and event name on the one browser hit
   * whose request to the container was in flight. `probable`: a shared value.
   */
  confidence: 'exact' | 'probable';
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
  /**
   * Sorted, unique names of the non-empty fields in the decoded payload of this hit (query, body, `dtdc`).
   * Nested names use dots and arrays collapse to `[]`. Never holds a value. Absent on version 1 records.
   */
  fields?: string[];
  /** False when the decoder could not see the whole payload. A rule that reads `fields` must not pass on such a hit. */
  fieldsComplete?: boolean;
  /** The subset of `fields` taken to be identifiers. Names only. */
  idFields?: string[];
  /** Set on a hit decoded from a server container call that was linked to a browser hit. */
  via?: HitVia;
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
  /** On a withdrawn epoch, the label it had before: what the banner action or update was. */
  outcome?: 'granted' | 'denied' | 'mixed';
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
  /** When the checkpoint was taken, on the same clock as `Request.t`. Absent on older records. */
  t?: number;
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
  /** Set on built-in checks. A failed `warn` result does not change the exit code. Absent means `fail`. */
  severity?: Severity;
  /** Why the result is not a plain pass or fail. */
  note?: ResultNote;
}

export type ResultNote =
  | 'stubNoCookies'
  | 'cannotEvaluateBody'
  | 'fieldsNotRecorded'
  | 'cookieNotStored'
  | 'nestedNameOnly'
  | 'serverSendProbableLink'
  | 'serverSendUnlinked';

export type Severity = 'fail' | 'warn';

export type FlagKind =
  | 'unknownDestination'
  | 'firstPartySubdomain'
  | 'possibleRealData'
  | 'sandboxPageUrl'
  | 'stubBypass'
  | 'unloadGap'
  | 'netLogUnreadable'
  | 'serverContainerFailed'
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

export type TagreeveRecord =
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

export type RecordType = TagreeveRecord['type'];
