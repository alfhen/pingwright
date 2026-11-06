import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_POST_DATA,
  newId,
  nodeNow,
  readVersion,
  pageTimeToEpoch,
  RunWriter,
  type CaptureCoverage,
  RECORD_SCHEMA_VERSION,
  type Checkpoint,
  type CheckpointCookie,
  type CollectorReport,
  type ConsentEpoch,
  type DataLayerEvent,
  type DataLayerFrame,
  type Flag,
  type Hit,
  type Id,
  type Identity,
  type InvalidReport,
  type NetworkMode,
  type Request,
  type Response,
  type Run,
  type RunRecords,
  type ServerContainerErrorClass,
  type ServerContainerPassThrough,
  type Step,
  type TagReport,
} from '@tagreeve/core';
import { HANDOFF_DONE_BINDING, HANDOFF_STATE_BINDING, HandoffGate, handoffOverlayScript, type HandoffState } from './handoff-overlay.ts';
import { buildEpochs, consentModeChanges, installConsent, type BannerEvent, type BannerResult, type ConsentDriver, type ConsentOptions } from '@tagreeve/consent';
import { decodeRequest, isCollectionEndpoint, trackerList, type TrackerEntry } from '@tagreeve/decoders';
import {
  chromium,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type Frame,
  type Request as PwRequest,
  type Response as PwResponse,
  type Route,
} from 'playwright';
import { routeCollector, type CollectorHandler, type ParsedReport } from './collector.ts';
import { COLLECTOR_ORIGIN, SELFTEST_ORIGIN } from './origins.ts';
import { DATALAYER_BINDING, DATALAYER_TALLY, dataLayerEventFromPayload, dataLayerInitScript, hookedLayerNames, type DataLayerPayload } from './datalayer.ts';
import { buildTallyFlags, PayloadCounts, postedAhead, validateTally, type FrameTally } from './datalayer-tally.ts';
import { buildDataLayerNotHookedFlag, loaderLayerName } from './datalayer-names.ts';
import { parseTagReport, TAG_REPORT_BINDING } from './tag-report.ts';
import { buildFlags, buildUnloadGapFlags, type FrameRef } from './flags.ts';
import { mergeNetLog, NavigationWindows, parseNetLog, watchNetLogDir, type NetLogRequest } from './netlog.ts';
import { redactHeaders } from './redact.ts';
import { runSelfTest } from './selftest.ts';
import { isKnownVendorCollection, isServerContainerRequest, isStubbedCollection, setCookieNameOf, setCookieNamesOf, stubResponse } from './stub.ts';
import { QUIET_MS, startServerContainerSession, waitForQuiet, type ServerContainerSession } from './server-container/capture.ts';
import { linkServerHits, type InFlightWindow } from './server-container/link.ts';
import { ServerContainerError, type ConfigSource } from './server-container/runner.ts';
import { onTerminate } from './terminate.ts';
import { UNLOAD_BINDING, UNLOAD_FLUSH, unloadInitScript, type UnloadSendPayload } from './unload.ts';
import { chromeUserAgent } from './user-agent.ts';
import {
  bodyHasContainer,
  isGtmJsUrl,
  isCrossOriginLoaderCandidate,
  isSniffableLoader,
  loaderHint,
  gtmFailureMessage,
  matchGtmRequest,
  parseGtmOverride,
  parseTestGtmOrigin,
  previewFetchUrl,
  testOriginUrl,
  TEST_GTM_ORIGIN_ENV,
  type GtmOverrideInput,
} from './gtm-override.ts';
import { Scrubber } from './gtm-scrub.ts';
import { loopbackIsHostedForTests } from './guard.ts';

export const TAGREEVE_VERSION = readVersion();
const REDACTED_VALUE = '[redacted]';
const TALLY_DEADLINE_MS = 2000;
const TALLY_POSTED_WAIT_MS = 1000;
const TAG_REPORT_QUIET_MS = 500;
const TAG_REPORT_MAX_WAIT_MS = 2500;


export interface ServerContainerOptions {
  configSource: ConfigSource;
  /** The image to run. Ignored by the stand-in of the test seam. */
  image: string;
}

export interface RecorderOptions {
  networkMode: NetworkMode;
  /** Needed by `server` mode: hosts or `*.domain` wildcards whose collection requests pass through. Every other one is still stubbed. */
  serverHosts?: string[];
  /** Directory that receives `<runId>.jsonl`. */
  outDir: string;
  /** The site under test. Requests to other hosts can be flagged as unknown destinations. */
  site: string;
  scenario?: string;
  /** Hosts or `*.domain` wildcards treated as first party besides the site's registrable domain. */
  firstPartyHosts?: string[];
  /** `false` keeps platform hosts as `unknownDestination`. Default: true. */
  platformHosts?: boolean;
  /** Event names or `*` globs that `unloadGap` never reports. */
  unloadGapIgnore?: string[];
  /** Global names to hook besides `dataLayer`. Their pushes carry `DataLayerEvent.layer`. */
  dataLayerNames?: string[];
  /** Stored on the run record as `graceWindowMs`. */
  graceWindowMs?: number;
  /** Installs the in-page Done control for handoff steps. `recordScenario` sets it when the scenario has a handoff. */
  handoffOverlay?: boolean;
  /** `block` stops service workers from registering. Default `allow`. */
  serviceWorkers?: 'allow' | 'block';
  /** Passed to `browser.newContext`. Absent keeps the Playwright default. */
  viewport?: { width: number; height: number };
  headed?: boolean;
  /** Autoconsent options, such as extra rule files. */
  autoconsent?: ConsentOptions;
  /** Test only: replaces the Chrome user agent. */
  userAgentOverride?: string;
  /** Serves the container's workspace build in place of the published one for this run only. */
  gtmOverride?: GtmOverrideInput;
  /** Tracker entries added to the built-in list. */
  trackerList?: readonly TrackerEntry[];
  /**
   * Launches Chromium with `--log-net-log` and adds collection requests that no browser hook reports (unload sends,
   * early sandboxed srcdoc sends) to the record, with `captured: 'netlog'`. Their bodies are not in the log. Off by default.
   * Needs `networkMode: 'live'`: in stub mode those sends would reach the network.
   */
  netLog?: boolean;
  /**
   * Runs the user's server container locally. Every non-load request to a `serverHosts` host goes to it, and the calls it
   * makes to vendors are recorded and answered here, never sent on. Needs `networkMode: 'server'`.
   */
  serverContainer?: ServerContainerOptions;
}

export interface StepActivity {
  requests: Request[];
  responses: Response[];
  dataLayerEvents: DataLayerEvent[];
}

export interface RunResult {
  path: string;
  records: RunRecords;
  /** Why the GTM override failed: no request matched, or a preview fetch was not 200. Absent when it worked or none was given. */
  gtmOverrideFailure?: string;
}

function redactRefererQuery(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /^(?:referer|origin)$/i.test(k) ? redactQuery(v) : v]));
}

function redactQuery(url: string): string {
  try {
    const parsed = new URL(url);
    for (const key of new Set(parsed.searchParams.keys())) parsed.searchParams.set(key, REDACTED_VALUE);
    return parsed.href;
  } catch {
    return url;
  }
}

const MAX_FOLLOWED_HOPS = 10;

function isTopLevelFrameRequest(request: PwRequest): boolean {
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

function frameUrlOf(request: PwRequest): string | null {
  try {
    return request.frame().url();
  } catch {
    // Requests from workers have no frame.
    return null;
  }
}

function initiatorOf(request: PwRequest): string | null {
  if (request.redirectedFrom()) return 'redirect';
  return request.serviceWorker() ? 'serviceWorker' : null;
}

export class Recorder {
  runId: Id<'run'> = newId('run');
  coverage!: CaptureCoverage;
  consent!: ConsentDriver;
  private run!: Run;
  private clockOffset = 0;
  private selfTestPrefix = '';
  private collectorHandler: CollectorHandler = () => undefined;
  private readonly requests = new Map<PwRequest, Request>();
  private readonly extraRequests: Request[] = [];
  private readonly loaderLayers: { id: Id<'req'>; name: string }[] = [];
  private readonly unloadKeys = new Set<string>();
  private readonly routed = new Set<string>();
  /** Memory only: never a record field. */
  private readonly containerFlights = new Map<string, InFlightWindow>();
  private readonly handedToChromium = new Set<string>();
  private readonly redirectHeaderWithoutRedirect = new Set<string>();
  private readonly selfRecorded = new WeakSet<PwRequest>();
  private readonly responses: Response[] = [];
  private readonly dataLayerEvents: DataLayerEvent[] = [];
  private readonly payloadCounts = new PayloadCounts();
  private readonly eventFrames = new Map<string, FrameRef>();
  private readonly frameNumbers = new WeakMap<Frame, number>();
  private readonly frameNavigations = new WeakMap<Frame, number>();
  private frameCount = 0;
  private readonly navigationSeen = new WeakSet<PwRequest>();
  private readonly requestFrameIds = new Map<string, string>();
  private readonly collectorReports: (CollectorReport | InvalidReport)[] = [];
  private readonly tagReports: TagReport[] = [];
  private lastTagReportAt = 0;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly steps: Step[] = [];
  private readonly checkpoints: Checkpoint[] = [];
  private readonly bannerEvents: BannerEvent[] = [];
  private currentStepId: Id<'stp'> | null = null;
  private readonly handoffWindows: { from: number; to: number | null; hold?: true }[] = [];
  readonly handoff = new HandoffGate();
  private closed = false;
  private readonly fetchErrors: string[] = [];
  private readonly loaderCandidates = new Map<string, boolean>();
  private readonly crossOriginScripts = new Set<string>();
  private readonly trackers: readonly TrackerEntry[];
  private readonly stubRecorded = new Set<string>();
  private readonly navigations: number[] = [];
  private readonly navigationWindows = new NavigationWindows<PwRequest>();
  private session: ServerContainerSession | undefined;
  private sessionStopped: Promise<void> | undefined;
  private removeSignalHandlers: (() => void) | undefined;
  /** Why the container did not start. Set by `launch`; `recordScenario` ends the run when it is. */
  containerFailure: { errorClass: ServerContainerErrorClass; message: string } | undefined;

  private constructor(
    private readonly options: RecorderOptions,
    private readonly browser: Browser,
    readonly context: BrowserContext,
    private readonly gtmOverride: GtmOverrideInput | undefined,
    private readonly testGtmOrigin: string | undefined,
    private readonly netLogPath: string | undefined,
    private readonly removeNetLogDir: (() => void) | undefined,
  ) {
    this.trackers = [...(options.trackerList ?? []), ...trackerList];
  }

  static async launch(options: RecorderOptions): Promise<Recorder> {
    const testGtmOrigin = parseTestGtmOrigin(process.env[TEST_GTM_ORIGIN_ENV]);
    const gtmOverride = options.gtmOverride === undefined ? undefined : parseGtmOverride(options.gtmOverride);
    if (options.networkMode === 'server' && !options.serverHosts?.length) {
      throw new Error('networkMode "server" needs serverHosts: the hosts whose requests pass through.');
    }
    if (options.serverContainer && options.networkMode !== 'server') {
      throw new Error('serverContainer needs networkMode "server": the hits to the serverHosts are what the container receives.');
    }
    if (options.netLog && options.networkMode !== 'live') {
      throw new Error('netLog needs networkMode "live": in stub mode the requests a frame sends while it unloads would leave the machine.');
    }
    let netLogPath: string | undefined;
    let removeNetLogDir: (() => void) | undefined;
    if (options.netLog) {
      const dir = await mkdtemp(join(tmpdir(), 'tagreeve-netlog-'));
      netLogPath = join(dir, 'netlog.json');
      removeNetLogDir = watchNetLogDir(dir);
    }
    let browser: Browser;
    try {
      browser = await chromium.launch({
        channel: 'chromium',
        headless: !options.headed,
        ...(netLogPath ? { args: [`--log-net-log=${netLogPath}`] } : {}),
        // Playwright's handlers exit the process once the browser is closed, before the containers are removed.
        ...(options.serverContainer ? { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false } : {}),
      });
    } catch (error) {
      removeNetLogDir?.();
      throw error;
    }
    try {
      const context = await browser.newContext({
        userAgent: options.userAgentOverride ?? chromeUserAgent(browser.version()),
        serviceWorkers: options.serviceWorkers ?? 'allow',
        ...(options.viewport ? { viewport: options.viewport } : {}),
      });
      const recorder = new Recorder(options, browser, context, gtmOverride, testGtmOrigin, netLogPath, removeNetLogDir);
      await recorder.init();
      await recorder.startContainer();
      return recorder;
    } catch (error) {
      try {
        await browser.close();
      } catch {
        // The launch error is the one to report.
      } finally {
        removeNetLogDir?.();
      }
      throw error;
    }
  }

  private async init(): Promise<void> {
    const { context } = this;
    // Registered first, so Playwright tries it last: the collector and self-test routes take precedence.
    await context.route('**/*', (route) => this.handleRoute(route));
    await routeCollector(context, () => this.collectorHandler, nodeNow);
    const selfTest = await runSelfTest(context, (h) => (this.collectorHandler = h));
    this.coverage = selfTest.coverage;
    this.clockOffset = selfTest.clockOffset;
    this.selfTestPrefix = selfTest.sourcePrefix;
    this.collectorHandler = (parsed, body, t) => this.storeReport(parsed, body, t);
    this.run = {
      type: 'run',
      id: this.runId,
      scenario: this.options.scenario ?? 'visit',
      site: this.options.site,
      startedAt: nodeNow(),
      recordSchemaVersion: RECORD_SCHEMA_VERSION,
      pingwrightVersion: TAGREEVE_VERSION,
      browser: { name: 'chromium', version: this.browser.version() },
      networkMode: this.options.networkMode,
      gtmOverride: this.gtmOverride
        ? {
            container: this.gtmOverride.container,
            gtmPreview: this.gtmOverride.gtmPreview,
            gtmAuth: '[redacted]',
            expectedTags: this.gtmOverride.expectedTags ?? [],
            applied: [],
          }
        : null,
      ...(this.testGtmOrigin ? { testGtmOrigin: this.testGtmOrigin } : {}),
      containerVersions: {},
      identity: null,
      coverage: selfTest.coverage,
      ...(this.options.graceWindowMs !== undefined ? { graceWindowMs: this.options.graceWindowMs } : {}),
      ...(this.options.viewport ? { viewport: { ...this.options.viewport } } : {}),
      ...(loopbackIsHostedForTests() ? { testLoopbackHosted: true as const } : {}),
    };
    await context.exposeBinding(DATALAYER_BINDING, (source, payload: DataLayerPayload) => {
      const isMain = source.frame === source.page.mainFrame();
      this.payloadCounts.add(payload ?? {}, this.frameNumber(source.frame), hookedLayerNames(this.options.dataLayerNames));
      const event = dataLayerEventFromPayload(payload, this.runId, this.clockOffset, { main: isMain, n: this.frameNumber(source.frame) });
      if (!event) return;
      this.dataLayerEvents.push({ ...event, stepId: this.currentStepId });
      if (!isMain) this.eventFrames.set(event.id, { id: this.frameDocumentId(source.frame), url: source.frame.url() });
    });
    await context.addInitScript(dataLayerInitScript(this.options.dataLayerNames));
    this.consent = await installConsent(context, this.options.autoconsent);
    await context.exposeBinding(TAG_REPORT_BINDING, (source, payload: unknown) => this.recordTagReport(source.frame, payload));
    if (this.options.networkMode !== 'live') {
      await context.exposeBinding(UNLOAD_BINDING, (source, payload: UnloadSendPayload) => this.recordUnloadSend(payload, this.frameDocumentId(source.frame)));
      await context.addInitScript(unloadInitScript);
    }
    if (this.options.handoffOverlay) {
      await context.exposeBinding(HANDOFF_STATE_BINDING, (source): HandoffState =>
        source.frame === source.page.mainFrame() ? this.handoff.state() : { waiting: false, text: '' });
      await context.exposeBinding(HANDOFF_DONE_BINDING, (source, nonce: unknown) => {
        if (source.frame === source.page.mainFrame()) this.handoff.done(nonce);
      });
      await context.addInitScript(handoffOverlayScript(this.handoff.nonce));
    }
    context.on('request', (request) => void this.recordFor(request));
    context.on('requestfailed', (request) => {
      const record = this.recordFor(request);
      if (!record) return;
      if (record.outcome === 'passed') record.outcome = 'failed';
      const errorText = request.failure()?.errorText;
      if (errorText) record.failure = errorText;
    });
    context.on('response', (response) => this.track(this.recordResponse(response)));
  }

  private async startContainer(): Promise<void> {
    const { serverContainer } = this.options;
    if (!serverContainer) return;
    const abort = new AbortController();
    const starting = startServerContainerSession({
      configSource: serverContainer.configSource,
      image: serverContainer.image,
      serverHosts: this.options.serverHosts ?? [],
      runId: this.runId,
      signal: abort.signal,
      currentStepId: () => this.currentStepId,
      onCapture: (request, response) => {
        // The proxy cannot tell which browser request led to a call, so a call is redacted by time: inside a window or within QUIET_MS after it.
        this.extraRequests.push(this.redactForHandoff(request, request.t, QUIET_MS));
        this.responses.push(response);
      },
    });
    // Registered before the start, which is the slowest part: a signal then cancels it and removes what it started.
    this.removeSignalHandlers = onTerminate(async () => {
      abort.abort();
      await this.browser.close().catch(() => undefined);
      const started = await starting.catch(() => undefined);
      if (started) this.session ??= started;
      await this.stopSession();
    });
    try {
      this.session = await starting;
    } catch (error) {
      this.removeSignalHandlers();
      this.removeSignalHandlers = undefined;
      if (!(error instanceof ServerContainerError)) throw error;
      this.containerFailure = { errorClass: error.errorClass, message: error.message };
      return;
    }
    if (this.session.standIn) this.run.testServerContainer = true;
  }

  /** Stops the container, the proxy and the CA once. Safe to call from `close` and from a signal. */
  private stopSession(): Promise<void> {
    this.removeSignalHandlers?.();
    this.removeSignalHandlers = undefined;
    this.sessionStopped ??= (async () => {
      await this.session?.stop();
    })();
    return this.sessionStopped;
  }

  private storeReport(parsed: ParsedReport, body: string, t: number): void {
    if (this.closed) return;
    // The self-test page keeps sending until it is closed, so a late report can arrive after the handler swap.
    if (parsed.ok && parsed.source.startsWith(this.selfTestPrefix)) return;
    if (parsed.ok) {
      this.collectorReports.push({
        type: 'collectorReport',
        id: newId('collectorReport'),
        runId: this.runId,
        t,
        source: parsed.source,
        payload: parsed.payload,
      });
    } else {
      this.collectorReports.push({
        type: 'invalidReport',
        id: newId('collectorReport'),
        runId: this.runId,
        t,
        error: parsed.error,
        body: body.slice(0, MAX_POST_DATA),
      });
    }
  }

  private track(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  private recordTagReport(frame: Frame, payload: unknown): void {
    if (this.closed) return;
    this.lastTagReportAt = Date.now();
    const parsed = parseTagReport(payload, 'web', { runId: this.runId, t: nodeNow(), stepId: this.currentStepId, frame: this.frameRef(frame) });
    if (!parsed.ok) {
      this.collectorReports.push(parsed.invalid);
      return;
    }
    this.tagReports.push(parsed.report);
    if (parsed.version !== null) this.run.containerVersions[parsed.report.container] = parsed.version;
  }

  private frameRef(frame: Frame): DataLayerFrame {
    return { main: frame === frame.page().mainFrame(), n: this.frameNumber(frame) };
  }

  private frameNumber(frame: Frame): number {
    let number = this.frameNumbers.get(frame);
    if (number === undefined) {
      number = this.frameCount++;
      this.frameNumbers.set(frame, number);
    }
    return number;
  }

  /** A frame document is the frame plus how many navigation requests the frame has started. Held in memory only. */
  private frameDocumentId(frame: Frame): string {
    return `${this.frameNumber(frame)}.${this.frameNavigations.get(frame) ?? 0}`;
  }

  private countNavigation(request: PwRequest): void {
    if (this.navigationSeen.has(request) || !request.isNavigationRequest()) return;
    this.navigationSeen.add(request);
    try {
      const frame = request.frame();
      this.frameNavigations.set(frame, (this.frameNavigations.get(frame) ?? 0) + 1);
    } catch {
      // Requests from workers have no frame.
    }
  }

  private requestFrameId(request: PwRequest): string | null {
    try {
      return this.frameDocumentId(request.frame());
    } catch {
      return null;
    }
  }

  /** Created on first sight, from either the request event or the route handler, whichever comes first. */
  private recordFor(request: PwRequest): Request | undefined {
    const existing = this.requests.get(request);
    if (existing) return existing;
    this.countNavigation(request);
    const url = request.url();
    // The collector and self-test origins are Tagreeve's own channel, not site traffic.
    if (!/^https?:/.test(url) || url.startsWith(COLLECTOR_ORIGIN) || url.startsWith(SELFTEST_ORIGIN)) return undefined;
    const body = request.postData();
    let frame: DataLayerFrame | undefined;
    try {
      frame = this.frameRef(request.frame());
    } catch {
      // Requests from workers have no frame.
    }
    let record: Request = {
      type: 'request',
      id: newId('request'),
      runId: this.runId,
      stepId: this.currentStepId,
      t: nodeNow(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      frameUrl: frameUrlOf(request),
      ...(frame ? { frame } : {}),
      initiator: initiatorOf(request),
      headers: redactHeaders(request.headers()),
      postData: body === null ? null : body.slice(0, MAX_POST_DATA),
      outcome: 'passed',
    };
    // Read before handoff redaction, which blanks the query.
    const loaderName = loaderLayerName(record);
    if (loaderName !== undefined) this.loaderLayers.push({ id: record.id, name: loaderName });
    record = this.redactForHandoff(record);
    this.requests.set(request, record);
    const frameId = this.requestFrameId(request);
    if (frameId !== null) this.requestFrameIds.set(record.id, frameId);
    if (request.isNavigationRequest() && isTopLevelFrameRequest(request)) {
      this.navigationWindows.start(request, record.t);
      this.navigations.push(record.t);
    }
    return record;
  }

  /** A person is typing during a handoff, so only requests that decode as tracking hits keep their body and query. */
  private redactForHandoff(record: Request, at = Date.now(), graceMs = 0): Request {
    if (!this.duringHandoff(at, graceMs)) return record;
    if (isCollectionEndpoint(record, this.trackers) || isKnownVendorCollection(record) || decodeRequest(record, undefined, this.trackers).length > 0) return record;
    return {
      ...record,
      url: redactQuery(record.url),
      frameUrl: record.frameUrl === null ? null : redactQuery(record.frameUrl),
      headers: redactRefererQuery(record.headers),
      postData: record.postData === null ? null : REDACTED_VALUE,
      redacted: 'handoff',
    };
  }

  private duringHandoff(at: number, graceMs: number): boolean {
    return this.handoffWindows.some((w) => at >= w.from && (w.to === null || at <= w.to + graceMs));
  }

  /** Requests sent while a handoff is active, including unload sends queued then and replayed later, are stored without their typed values. */
  setHandoff(active: boolean): void {
    if (active) this.handoffWindows.push({ from: Date.now(), to: null });
    else {
      const open = this.handoffWindows.find((w) => w.to === null && !w.hold);
      if (open) open.to = Date.now();
    }
  }

  /** Opens a redaction window that setHandoff(false) never closes. It lasts until the run ends. */
  holdRedaction(): void {
    this.handoffWindows.push({ from: Date.now(), to: null, hold: true });
  }

  private recordUnloadSend(payload: UnloadSendPayload, frameId: string): void {
    if (this.closed || this.unloadKeys.has(payload.key)) return;
    this.unloadKeys.add(payload.key);
    let record: Request = {
      type: 'request',
      id: newId('request'),
      runId: this.runId,
      stepId: this.currentStepId,
      t: nodeNow(),
      method: payload.method,
      url: payload.url,
      resourceType: payload.resourceType,
      frameUrl: payload.frameUrl,
      initiator: 'unload',
      headers: redactHeaders(payload.headers ?? {}),
      postData: payload.postData === null ? null : payload.postData.slice(0, MAX_POST_DATA),
      outcome: 'stubbed',
    };
    record = this.redactForHandoff(record, payload.queuedAt);
    this.requestFrameIds.set(record.id, frameId);
    this.routed.add(record.id);
    this.extraRequests.push(record);
    this.responses.push({ type: 'response', id: newId('response'), requestId: record.id, status: 204, setCookieNames: [] });
  }

  private async readNetLog(): Promise<NetLogRequest[] | undefined> {
    if (!this.netLogPath) return undefined;
    try {
      return parseNetLog(await readFile(this.netLogPath, 'utf8'));
    } catch {
      return undefined;
    } finally {
      this.removeNetLogDir?.();
    }
  }

  private async recordResponse(response: PwResponse): Promise<void> {
    if (this.selfRecorded.has(response.request())) return;
    const record = this.recordFor(response.request());
    if (!record) return;
    this.navigationWindows.respond(response.request(), nodeNow());
    if (this.stubRecorded.has(record.id)) return;
    let setCookieNames: string[] = [];
    try {
      if (response.status() !== 201 && (response.status() < 300 || response.status() >= 400) && (await response.headerValue('location')) !== null) this.redirectHeaderWithoutRedirect.add(record.id);
      setCookieNames = (await response.headerValues('set-cookie')).flatMap(setCookieNameOf);
    } catch {
      // The page closed before the headers arrived.
    }
    this.responses.push({
      type: 'response',
      id: newId('response'),
      requestId: record.id,
      status: response.status(),
      setCookieNames,
    });
  }

  private async handleRoute(route: Route): Promise<void> {
    const record = this.recordFor(route.request());
    if (record) this.routed.add(record.id);
    if (record && (await this.routeGtm(route, record))) return;
    if (record && this.session && isServerContainerRequest(record, this.options.serverHosts ?? [])) {
      await this.routeToContainer(route, record, this.session.origin);
      return;
    }
    if (record && this.options.networkMode !== 'live' && this.isStubbedCollection(record)) {
      record.outcome = 'stubbed';
      const stub = stubResponse(record);
      this.stubRecorded.add(record.id);
      this.recordResponseFor(record, stub.status, setCookieNamesOf(stub.headers));
      await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
      return;
    }
    if (record && this.options.networkMode !== 'live') {
      await this.routeWithRedirectCheck(route, record);
      return;
    }
    if (record) this.handedToChromium.add(record.id);
    await route.continue();
  }

  /** Answers a non-load request to a `serverHosts` host with the local container's response. It never reaches the remote host. */
  private async routeToContainer(route: Route, record: Request, origin: string): Promise<void> {
    const original = route.request();
    const live = new URL(original.url());
    // A separate client, so the container's loopback address never reads or writes the context cookie jar.
    // allHeaders() holds the Cookie header Chromium would send, so SameSite and credentials mode already apply.
    // The client falls back to its own jar when the header is absent, so each call gets a client with an empty jar that no other call shares.
    // An empty cookie header must never be added: it would go out as an empty Cookie header.
    const { host: _host, ...headers } = await original.allHeaders();
    void _host;
    record.outcome = 'stubbed';
    this.stubRecorded.add(record.id);
    let client: APIRequestContext | undefined;
    try {
      client = await playwrightRequest.newContext();
      const sentAt = nodeNow();
      const response = await client.fetch(`${origin}${live.pathname}${live.search}`, {
        method: original.method(),
        headers,
        data: original.postDataBuffer() ?? undefined,
        maxRedirects: 0,
      });
      this.containerFlights.set(record.id, { sentAt, answeredAt: nodeNow() });
      this.recordApiResponse(record, response);
      await route.fulfill({ response });
    } catch (error) {
      record.outcome = 'failed';
      record.failure = abortCode(error);
      await route.abort(abortCode(error));
    } finally {
      await client?.dispose().catch(() => undefined);
    }
  }

  private isStubbedCollection(record: Request): boolean {
    return isStubbedCollection(record, {
      networkMode: this.options.networkMode,
      serverHosts: this.options.serverHosts,
      trackers: this.trackers,
    });
  }

  /** Answers a gtm.js request, directly or through a loader, with the preview build, or from the test origin. Returns false when the request is not one of those. */
  private async routeGtm(route: Route, record: Request): Promise<boolean> {
    const { gtmOverride, testGtmOrigin } = this;
    // record.url may be redacted during a handoff window; match on the live URL.
    const liveUrl = route.request().url();
    let match = gtmOverride === undefined ? undefined : matchGtmRequest(liveUrl, record, gtmOverride);
    if (!match && gtmOverride && isCrossOriginLoaderCandidate(liveUrl, record.resourceType, this.options.site)) this.crossOriginScripts.add(liveUrl);
    if (!match && gtmOverride && !gtmOverride.loader && this.isUnseenLoaderCandidate(liveUrl, record)) {
      const sniff = await this.sniffLoader(route, liveUrl, gtmOverride.container);
      if (!sniff) return false;
      if (!sniff.matched) {
        await route.fulfill({ response: sniff.response });
        return true;
      }
      match = {
        applied: { way: 'loader', loader: 'stape', url: record.url, loses: 'everything the loader does beyond fetching the container' },
        pageParams: new URL(liveUrl).searchParams,
      };
    }
    const applied = match?.applied;
    if (!applied && !(testGtmOrigin && isGtmJsUrl(liveUrl))) return false;
    const target = applied ? previewFetchUrl(gtmOverride!, testGtmOrigin, match!.pageParams) : testOriginUrl(liveUrl, testGtmOrigin!);
    let response: APIResponse;
    try {
      response = await route.fetch({ url: target });
    } catch (error) {
      if (applied) this.run.gtmOverride!.applied.push({ ...applied, status: 0 });
      this.fetchErrors.push(error instanceof Error ? error.message : String(error));
      await route.abort('failed');
      return true;
    }
    if (applied) this.run.gtmOverride!.applied.push({ ...applied, status: response.status() });
    await route.fulfill({ response });
    return true;
  }

  private isUnseenLoaderCandidate(liveUrl: string, record: Request): boolean {
    if (this.loaderCandidates.get(liveUrl) === false) return false;
    if (!isSniffableLoader(liveUrl, record.resourceType, this.options.site, this.options.firstPartyHosts)) return false;
    return !isCollectionEndpoint(record, this.trackers) && !isKnownVendorCollection(record);
  }

  /** Fetches a script that may be a Stape loader and checks whether it is the container. Returns undefined when the fetch fails. A redirect is handed back unchanged, so Chromium follows it and the recorder sees every hop without a second request. */
  private async sniffLoader(route: Route, liveUrl: string, container: string): Promise<{ response: APIResponse; matched: boolean } | undefined> {
    try {
      const response = await route.fetch({ maxRedirects: 0 });
      if (response.status() >= 300 && response.status() < 400) {
        this.loaderCandidates.set(liveUrl, false);
        return { response, matched: false };
      }
      const matched = response.ok() && bodyHasContainer(await response.text(), container);
      this.loaderCandidates.set(liveUrl, matched);
      return { response, matched };
    } catch {
      return undefined;
    }
  }

  private recordServerContainer(
    requests: readonly Request[],
    hits: readonly Hit[],
    counts: { passThrough: ServerContainerPassThrough; refused: number } | undefined,
    flags: Flag[],
  ): void {
    const options = this.options.serverContainer;
    if (!options) return;
    const fromContainer = new Set(requests.filter((r) => r.captured === 'serverContainer').map((r) => r.id));
    const failure = this.containerFailure;
    this.run.serverContainer = {
      image: this.session?.image ?? options.image,
      startedAt: this.session?.startedAt ?? nodeNow(),
      requests: fromContainer.size,
      passThrough: counts?.passThrough ?? { serverjs: 0, config: 0, destination: 0 },
      refused: counts?.refused ?? 0,
      unlinked: hits.filter((h) => fromContainer.has(h.requestId) && h.via === undefined).length,
      ...(failure ? { error: failure.errorClass } : {}),
    };
    if (failure) {
      flags.push({ type: 'flag', id: newId('flag'), runId: this.runId, kind: 'serverContainerFailed', recordIds: [], detail: `The server container did not run: ${failure.errorClass}.` });
    }
  }

  private gtmFailure(): string | undefined {
    const applied = this.run.gtmOverride?.applied;
    if (!applied || !this.gtmOverride) return undefined;
    const hint = applied.length === 0 ? loaderHint([...this.loaderCandidates.keys()], [...this.crossOriginScripts]) : '';
    return gtmFailureMessage(this.gtmOverride, applied, this.fetchErrors[0], hint);
  }

  /**
   * Playwright never routes the hops of a redirect chain, so a redirect to a collection endpoint would reach the
   * network in stub mode. Only same-origin, non-navigation requests of the top-level frame are fetched here, and
   * hops are followed only while they stay on that origin: Playwright's request client would otherwise send
   * cookies and Authorization across origins and keep Set-Cookie where Chromium would not.
   * Playwright's request client keeps its own cookie jar, which matches Chromium's rules only for the top-level
   * frame (a sandboxed child frame has an opaque origin, so its requests are cross-site for cookies), and a
   * fulfilled document loses its loopback address space. Everything else goes to Chromium untouched, and a
   * redirect from it to a collection endpoint can still leave the machine (flagged `stubBypass`). The first
   * collection hop gets the stub. A fetch with credentials: 'omit' cannot be seen from Playwright, so it is fetched
   * with the jar cookies (design §5.3).
   */
  private async routeWithRedirectCheck(route: Route, first: Request): Promise<void> {
    const original = route.request();
    if (!this.isFetchableRequest(original)) {
      this.handedToChromium.add(first.id);
      await route.continue();
      return;
    }
    let method = first.method;
    let postData: Buffer | null = original.postDataBuffer();
    let headers: Record<string, string> = original.headers();
    let url = first.url;
    let response: APIResponse;
    let current = first;
    this.selfRecorded.add(original);
    try {
      response = await route.fetch({ maxRedirects: 0, timeout: 0 });
    } catch (error) {
      await route.abort(abortCode(error));
      return;
    }
    this.recordApiResponse(current, response);
    for (let hops = 0; hops <= MAX_FOLLOWED_HOPS; hops++) {
      const location = response.headers().location;
      const status = response.status();
      if (!location || status < 300 || status >= 400) break;
      let next: URL | null = null;
      try {
        next = new URL(location, url);
      } catch {
        // An unparsable Location is the browser's to reject.
      }
      if (!next || !/^https?:$/.test(next.protocol)) break;
      const toGet = [301, 302].includes(status) ? method === 'POST' : status === 303 && method !== 'HEAD';
      if (toGet) {
        if (method !== 'GET') headers = withoutMethodChangeHeaders(headers);
        method = 'GET';
        postData = null;
      }
      const hop = this.hopRecord(first, next.href, method, headers, postData);
      if (this.isStubbedCollection(hop)) {
        hop.outcome = 'stubbed';
        this.routed.add(hop.id);
        this.extraRequests.push(hop);
        const stub = stubResponse(first);
        this.recordResponseFor(hop, stub.status, setCookieNamesOf(stub.headers));
        await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
        return;
      }
      // The hop past the limit is still checked above, so a collection endpoint there is stubbed, not handed back.
      if (hops === MAX_FOLLOWED_HOPS || !this.isSameOriginUrl(next.href)) break;
      this.extraRequests.push(hop);
      this.routed.add(hop.id);
      current = hop;
      try {
        // route.fetch always falls back to the original request's body, and an explicit empty body adds a
        // content-type, so a hop with no body goes through the context's request client, which shares its cookies.
        response =
          postData === null
            ? await this.context.request.fetch(next.href, { method, headers, maxRedirects: 0, timeout: 0 })
            : await route.fetch({ url: next.href, method, headers, postData, maxRedirects: 0, timeout: 0 });
      } catch (error) {
        await route.abort(abortCode(error));
        return;
      }
      url = next.href;
      this.recordApiResponse(current, response);
    }
    // Chromium applies a handed-back redirect to the original request, so after a method change it must see a
    // 303, or a 307, 308 (any method) or 301/302 (non-POST) re-sends the original method and body to the next host.
    const isRedirect = response.status() >= 300 && response.status() < 400;
    await route.fulfill(method !== first.method && isRedirect ? { response, status: 303 } : { response });
  }

  private isSameOriginUrl(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.options.site).origin;
    } catch {
      return false;
    }
  }

  private isFetchableRequest(request: PwRequest): boolean {
    if (request.isNavigationRequest() || !isTopLevelFrameRequest(request)) return false;
    const frame = frameUrlOf(request);
    if (frame === null || !this.isSameOriginUrl(request.url())) return false;
    return frame === 'about:blank' || this.isSameOriginUrl(frame);
  }

  private hopRecord(first: Request, url: string, method: string, headers: Record<string, string>, postData: Buffer | null): Request {
    const body = postData === null ? null : postData.toString('utf8').slice(0, MAX_POST_DATA);
    const record = this.redactForHandoff({
      ...first,
      id: newId('request'),
      t: nodeNow(),
      method,
      url,
      initiator: 'redirect',
      headers: redactHeaders(headers),
      postData: body,
      outcome: 'passed',
    });
    const frameId = this.requestFrameIds.get(first.id);
    if (frameId !== undefined) this.requestFrameIds.set(record.id, frameId);
    return record;
  }

  private recordResponseFor(record: Request, status: number, setCookieNames: string[]): void {
    this.responses.push({ type: 'response', id: newId('response'), requestId: record.id, status, setCookieNames });
  }

  private recordApiResponse(record: Request, response: APIResponse): void {
    const setCookieNames = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .flatMap((h) => setCookieNameOf(h.value));
    this.recordResponseFor(record, response.status(), setCookieNames);
  }

  get site(): string {
    return this.options.site;
  }

  setIdentity(identity: Identity): void {
    this.run.identity = { ...identity };
    this.run.identitySeed = identity.seed;
  }

  /** Requests, hits and dataLayer events recorded from now on carry this step's id, until the next step begins. */
  beginStep(label: string, index: number): Step {
    const step: Step = { type: 'step', id: newId('step'), runId: this.runId, index, label, startedAt: nodeNow(), endedAt: null };
    this.steps.push(step);
    this.currentStepId = step.id;
    return step;
  }

  /** What the recorder has seen so far while the step ran. */
  stepActivity(step: Step): StepActivity {
    const requests = [...this.requests.values(), ...this.extraRequests].filter((r) => r.stepId === step.id);
    const ids = new Set(requests.map((r) => r.id));
    return {
      requests,
      responses: this.responses.filter((r) => ids.has(r.requestId)),
      dataLayerEvents: this.dataLayerEvents.filter((e) => e.stepId === step.id),
    };
  }

  endStep(step: Step, error?: string): void {
    step.endedAt = nodeNow();
    if (error !== undefined) step.error = error;
  }

  /** Keeps a banner action for the run's epochs. Only actions that were carried out count. Banner times are page-clock readings. */
  recordBanner(result: BannerResult): void {
    if (result.result !== 'ok' || result.action === 'none') return;
    this.bannerEvents.push({
      t: pageTimeToEpoch(result.t, this.clockOffset),
      tEnd: pageTimeToEpoch(result.tEnd, this.clockOffset),
      action: result.action,
    });
  }

  private buildConsentEpochs(): ConsentEpoch[] {
    // The page's consent state comes from its main frame. A gtag call in an embedded frame has its own state.
    const mainFrameEvents = this.dataLayerEvents.filter((e) => e.frame?.main);
    const drafts = buildEpochs(this.bannerEvents, consentModeChanges(mainFrameEvents, Math.min(...this.bannerEvents.map((b) => b.t))), { startT: this.run.startedAt });
    return drafts.map((epoch) => ({
      type: 'consentEpoch',
      id: newId('consentEpoch'),
      runId: this.runId,
      ...epoch,
    }));
  }

  async checkpoint(label: string, step: Step | null): Promise<Checkpoint> {
    const host = new URL(this.options.site).hostname;
    const cookies: CheckpointCookie[] = (await this.context.cookies()).map((c) => {
      const domain = c.domain.replace(/^\./, '');
      return {
        name: c.name,
        domain: c.domain,
        expires: c.expires > 0 ? c.expires * 1000 : null,
        firstParty: host === domain || host.endsWith(`.${domain}`),
      };
    });
    const checkpoint: Checkpoint = {
      type: 'checkpoint',
      id: newId('checkpoint'),
      runId: this.runId,
      stepId: step?.id ?? this.currentStepId,
      label,
      t: nodeNow(),
      consentState: null,
      cookies,
    };
    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  async visit(url: string): Promise<Page> {
    const page = await this.context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    return page;
  }

  async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async flushUnloadQueues(): Promise<void> {
    const script = `window.${UNLOAD_FLUSH}?.()`;
    for (const page of this.context.pages()) {
      await page.evaluate(script).catch(() => undefined);
    }
    await this.wait(50);
  }

  /** Asks each open frame how many items its hooked arrays hold, so a gap against the records can be flagged. */
  private async collectTallies(): Promise<FrameTally[]> {
    const names = hookedLayerNames(this.options.dataLayerNames);
    const tallies: FrameTally[] = [];
    let frames: Frame[] = [];
    try {
      frames = this.context.pages().flatMap((page) => page.frames());
    } catch {
      return tallies;
    }
    const script = `window.${DATALAYER_TALLY}?.()`;
    const asking = frames.map(async (frame) => {
      try {
        const tally = validateTally(this.frameNumber(frame), await frame.evaluate(script), names);
        if (tally) tallies.push(tally);
      } catch {
        // a frame that fails or detaches gets no flag
      }
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TALLY_DEADLINE_MS);
    });
    await Promise.race([Promise.all(asking), deadline]);
    clearTimeout(timer);
    return [...tallies];
  }

  private async tallyDataLayers(): Promise<Flag[]> {
    const tallies = await this.collectTallies();
    const start = Date.now();
    while (postedAhead(tallies, this.payloadCounts) && Date.now() - start < TALLY_POSTED_WAIT_MS) await this.wait(20);
    return buildTallyFlags(this.runId, tallies, this.payloadCounts);
  }

  private noteContainerExit(): void {
    if (this.session?.containerExited() && !this.containerFailure) {
      this.containerFailure = { errorClass: 'exited', message: 'The server container ended during the run.' };
    }
  }

  /** GTM calls back up to its event timeout after an event, so a report can arrive well after the last step. */
  private async waitForLateTagReports(): Promise<void> {
    if (this.tagReports.length === 0) return;
    await waitForQuiet(() => this.lastTagReportAt, { quietMs: TAG_REPORT_QUIET_MS, maxMs: TAG_REPORT_MAX_WAIT_MS });
  }

  /** Closes the browser, decodes the requests and writes `<outDir>/<runId>.jsonl`. */
  async close(): Promise<RunResult> {
    const closeStartedAt = nodeNow();
    this.noteContainerExit();
    await this.waitForLateTagReports();
    if (this.options.networkMode !== 'live') await this.flushUnloadQueues();
    const tallyFlags = await this.tallyDataLayers();
    if (this.session) {
      const session = this.session;
      await waitForQuiet(() => session.lastCallAt());
      session.stopRecording();
      this.noteContainerExit();
    }
    this.closed = true;
    try {
      await this.browser.close();
    } catch (error) {
      this.removeNetLogDir?.();
      await this.stopSession();
      throw error;
    }
    await Promise.allSettled([...this.pending]);
    const containerCounts = this.session && { passThrough: this.session.passThrough(), refused: this.session.refused() };
    await this.stopSession();

    const netLog = await this.readNetLog();
    if (netLog) {
      const { requests: added, responses } = mergeNetLog(netLog, [...this.requests.values(), ...this.extraRequests], this.steps, this.trackers, this.runId, this.navigationWindows.list());
      this.extraRequests.push(...added);
      this.responses.push(...responses);
    }
    const requests = [...this.requests.values(), ...this.extraRequests];
    let hits: Hit[] = requests.flatMap((r) => decodeRequest(r, undefined, this.trackers));
    if (this.session) hits = linkServerHits({ hits, requests, serverHosts: this.options.serverHosts ?? [], identity: this.run.identity, inFlight: this.containerFlights });
    const flags = buildFlags({
      runId: this.runId,
      networkMode: this.options.networkMode,
      siteUrl: this.options.site,
      firstPartyHosts: this.options.firstPartyHosts,
      platformHosts: this.options.platformHosts,
      trackers: this.trackers,
      requests,
      hits,
      identity: this.run.identity,
      routedRequestIds: this.routed,
      responses: this.responses,
      handedToChromium: this.handedToChromium,
      redirectHeaderWithoutRedirect: this.redirectHeaderWithoutRedirect,
    });
    if (!this.netLogPath) {
      const embedded = this.dataLayerEvents.filter((e) => !e.frame?.main);
      flags.push(...buildUnloadGapFlags({ runId: this.runId, networkMode: this.options.networkMode, events: embedded, hits, navigations: this.navigations, runEnd: closeStartedAt, eventFrames: this.eventFrames, requestFrames: new Map(requests.map((r) => [r.id, { id: this.requestFrameIds.get(r.id) ?? null, url: r.frameUrl }])), ignore: this.options.unloadGapIgnore }));
    } else if (!netLog) {
      flags.push({ type: 'flag', id: newId('flag'), runId: this.runId, kind: 'netLogUnreadable', recordIds: [], detail: 'The net log could not be read, so requests sent while a frame unloads may be missing.' });
    }
    const notHooked = buildDataLayerNotHookedFlag({ runId: this.runId, loaders: this.loaderLayers, hooked: this.options.dataLayerNames ?? [] });
    if (notHooked) flags.push(notHooked);
    flags.push(...tallyFlags);
    this.recordServerContainer(requests, hits, containerCounts, flags);
    const consentEpochs = this.buildConsentEpochs();
    let records: RunRecords = {
      run: this.run,
      steps: this.steps,
      requests,
      responses: this.responses,
      hits,
      dataLayerEvents: this.dataLayerEvents,
      tagReports: this.tagReports,
      consentEpochs,
      checkpoints: this.checkpoints,
      results: [],
      flags,
      collectorReports: this.collectorReports.filter((r): r is CollectorReport => r.type === 'collectorReport'),
      invalidReports: this.collectorReports.filter((r): r is InvalidReport => r.type === 'invalidReport'),
    };
    const gtmOverrideFailure = this.gtmFailure();
    // Last step: decoding, flags and the built-in checks have seen the raw records.
    const scrubber = this.gtmOverride ? new Scrubber(this.gtmOverride.gtmAuth) : undefined;
    if (scrubber) records = scrubber.records(records);
    const writer = await RunWriter.create(this.options.outDir, records.run);
    try {
      for (const record of [
        ...records.requests,
        ...records.steps,
        ...records.checkpoints,
        ...records.responses,
        ...records.hits,
        ...records.dataLayerEvents,
        ...records.tagReports,
        ...records.consentEpochs,
        ...records.collectorReports,
        ...records.invalidReports,
        ...records.flags,
      ]) {
        await writer.append(record);
      }
    } finally {
      await writer.close();
    }
    const failure = gtmOverrideFailure && scrubber ? scrubber.text(gtmOverrideFailure) : gtmOverrideFailure;
    return { path: writer.path, records, ...(failure ? { gtmOverrideFailure: failure } : {}) };
  }
}

export function launchRecorder(options: RecorderOptions): Promise<Recorder> {
  return Recorder.launch(options);
}

export interface RecordVisitOptions extends RecorderOptions {
  startUrl: string;
  waitMs: number;
}

/** A run for now: visit the start URL, wait, close. */
export async function recordVisit(options: RecordVisitOptions): Promise<RunResult> {
  const recorder = await launchRecorder(options);
  try {
    await recorder.visit(options.startUrl);
    await recorder.wait(options.waitMs);
  } catch (error) {
    await recorder.close().catch(() => undefined);
    throw error;
  }
  return recorder.close();
}

function abortCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('ERR_CONNECTION_REFUSED') || message.includes('ECONNREFUSED')) return 'connectionrefused';
  if (message.includes('ERR_NAME_NOT_RESOLVED') || message.includes('ENOTFOUND')) return 'namenotresolved';
  if (message.includes('ETIMEDOUT') || message.includes('ERR_TIMED_OUT')) return 'timedout';
  if (message.includes('ECONNRESET') || message.includes('ERR_CONNECTION_RESET')) return 'connectionreset';
  return 'failed';
}

// Fetch spec and Chromium: a redirect that changes the method to GET drops the body, its headers and Origin.
const BODY_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location', 'origin']);

function withoutMethodChangeHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
}
