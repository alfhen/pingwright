import {
  newId,
  nodeNow,
  readVersion,
  pageTimeToEpoch,
  RunWriter,
  type CaptureCoverage,
  type Checkpoint,
  type CheckpointCookie,
  type CollectorReport,
  type ConsentEpoch,
  type DataLayerEvent,
  type Hit,
  type Id,
  type Identity,
  type InvalidReport,
  type NetworkMode,
  type Request,
  type Response,
  type Run,
  type RunRecords,
  type Step,
} from '@pingwright/core';
import { buildEpochs, consentModeChanges, installConsent, type BannerEvent, type BannerResult, type ConsentDriver, type ConsentOptions } from '@pingwright/consent';
import { decodeRequest, isCollectionEndpoint } from '@pingwright/decoders';
import {
  chromium,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
  type Request as PwRequest,
  type Response as PwResponse,
  type Route,
} from 'playwright';
import { routeCollector, type CollectorHandler, type ParsedReport } from './collector.ts';
import { COLLECTOR_ORIGIN, SELFTEST_ORIGIN } from './origins.ts';
import { DATALAYER_BINDING, dataLayerEventFromPayload, dataLayerInitScript, type DataLayerPayload } from './datalayer.ts';
import { buildFlags } from './flags.ts';
import { runSelfTest } from './selftest.ts';
import { isKnownVendorCollection, stubResponse } from './stub.ts';
import { UNLOAD_BINDING, UNLOAD_FLUSH, unloadInitScript, type UnloadSendPayload } from './unload.ts';
import { chromeUserAgent } from './user-agent.ts';

export const PINGWRIGHT_VERSION = readVersion();
export const MAX_POST_DATA = 64 * 1024;
const REDACTED_VALUE = '[redacted]';

const REDACTED_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export interface RecorderOptions {
  networkMode: Extract<NetworkMode, 'stub' | 'live'>;
  /** Directory that receives `<runId>.jsonl`. */
  outDir: string;
  /** The site under test. Requests to other hosts can be flagged as unknown destinations. */
  site: string;
  scenario?: string;
  /** Hosts or `*.domain` wildcards treated as first party besides the site's registrable domain. */
  firstPartyHosts?: string[];
  /** `block` stops service workers from registering. Default `allow`. */
  serviceWorkers?: 'allow' | 'block';
  headed?: boolean;
  /** Autoconsent options, such as extra rule files. */
  autoconsent?: ConsentOptions;
  /** Test only: replaces the Chrome user agent. */
  userAgentOverride?: string;
}

export interface StepActivity {
  requests: Request[];
  dataLayerEvents: DataLayerEvent[];
}

export interface RunResult {
  path: string;
  records: RunRecords;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, REDACTED_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v]),
  );
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
  private readonly unloadKeys = new Set<string>();
  private readonly routed = new Set<string>();
  private readonly selfRecorded = new WeakSet<PwRequest>();
  private readonly responses: Response[] = [];
  private readonly dataLayerEvents: DataLayerEvent[] = [];
  private readonly mainFrameEventIds = new Set<string>();
  private readonly collectorReports: (CollectorReport | InvalidReport)[] = [];
  private readonly pending = new Set<Promise<unknown>>();
  private readonly steps: Step[] = [];
  private readonly checkpoints: Checkpoint[] = [];
  private readonly bannerEvents: BannerEvent[] = [];
  private currentStepId: Id<'stp'> | null = null;
  private readonly handoffWindows: { from: number; to: number | null }[] = [];
  private closed = false;

  private constructor(
    private readonly options: RecorderOptions,
    private readonly browser: Browser,
    readonly context: BrowserContext,
  ) {}

  static async launch(options: RecorderOptions): Promise<Recorder> {
    const browser = await chromium.launch({ channel: 'chromium', headless: !options.headed });
    try {
      const context = await browser.newContext({
        userAgent: options.userAgentOverride ?? chromeUserAgent(browser.version()),
        serviceWorkers: options.serviceWorkers ?? 'allow',
      });
      const recorder = new Recorder(options, browser, context);
      await recorder.init();
      return recorder;
    } catch (error) {
      await browser.close();
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
      pingwrightVersion: PINGWRIGHT_VERSION,
      browser: { name: 'chromium', version: this.browser.version() },
      networkMode: this.options.networkMode,
      gtmOverride: null,
      containerVersions: {},
      identity: null,
      coverage: selfTest.coverage,
    };
    await context.exposeBinding(DATALAYER_BINDING, (source, payload: DataLayerPayload) => {
      const event = dataLayerEventFromPayload(payload, this.runId, this.clockOffset);
      if (!event) return;
      this.dataLayerEvents.push({ ...event, stepId: this.currentStepId });
      if (source.frame === source.page.mainFrame()) this.mainFrameEventIds.add(event.id);
    });
    await context.addInitScript(dataLayerInitScript);
    this.consent = await installConsent(context, this.options.autoconsent);
    if (this.options.networkMode !== 'live') {
      await context.exposeBinding(UNLOAD_BINDING, (_source, payload: UnloadSendPayload) => this.recordUnloadSend(payload));
      await context.addInitScript(unloadInitScript);
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

  /** Created on first sight, from either the request event or the route handler, whichever comes first. */
  private recordFor(request: PwRequest): Request | undefined {
    const existing = this.requests.get(request);
    if (existing) return existing;
    const url = request.url();
    // The collector and self-test origins are Pingwright's own channel, not site traffic.
    if (!/^https?:/.test(url) || url.startsWith(COLLECTOR_ORIGIN) || url.startsWith(SELFTEST_ORIGIN)) return undefined;
    const body = request.postData();
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
      initiator: initiatorOf(request),
      headers: redactHeaders(request.headers()),
      postData: body === null ? null : body.slice(0, MAX_POST_DATA),
      outcome: 'passed',
    };
    record = this.redactForHandoff(record);
    this.requests.set(request, record);
    return record;
  }

  /** A person is typing during a handoff, so only requests that decode as tracking hits keep their body and query. */
  private redactForHandoff(record: Request, at = Date.now()): Request {
    if (!this.duringHandoff(at)) return record;
    if (isCollectionEndpoint(record) || isKnownVendorCollection(record) || decodeRequest(record).length > 0) return record;
    return {
      ...record,
      url: redactQuery(record.url),
      postData: record.postData === null ? null : REDACTED_VALUE,
      redacted: 'handoff',
    };
  }

  private duringHandoff(at: number): boolean {
    return this.handoffWindows.some((w) => at >= w.from && (w.to === null || at <= w.to));
  }

  /** Requests sent while a handoff is active, including unload sends queued then and replayed later, are stored without their typed values. */
  setHandoff(active: boolean): void {
    if (active) this.handoffWindows.push({ from: Date.now(), to: null });
    else {
      const open = this.handoffWindows.find((w) => w.to === null);
      if (open) open.to = Date.now();
    }
  }

  private recordUnloadSend(payload: UnloadSendPayload): void {
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
    this.routed.add(record.id);
    this.extraRequests.push(record);
    this.responses.push({ type: 'response', id: newId('response'), requestId: record.id, status: 204, setCookieNames: [] });
  }

  private async recordResponse(response: PwResponse): Promise<void> {
    if (this.selfRecorded.has(response.request())) return;
    const record = this.recordFor(response.request());
    if (!record) return;
    let setCookieNames: string[] = [];
    try {
      setCookieNames = (await response.headerValues('set-cookie')).map((c) => c.split('=')[0]!.trim());
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
    if (record && this.options.networkMode !== 'live' && (isCollectionEndpoint(record) || isKnownVendorCollection(record))) {
      record.outcome = 'stubbed';
      const stub = stubResponse(record);
      await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
      return;
    }
    if (record && this.options.networkMode !== 'live') {
      await this.routeWithRedirectCheck(route, record);
      return;
    }
    await route.continue();
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
      await route.continue();
      return;
    }
    let method = first.method;
    let postData: Buffer | null = original.postDataBuffer();
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
    for (let hops = 0; hops < MAX_FOLLOWED_HOPS; hops++) {
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
        method = 'GET';
        postData = null;
      }
      const hop = this.hopRecord(first, next.href, method, original.headers(), postData);
      if (isCollectionEndpoint(hop) || isKnownVendorCollection(hop)) {
        hop.outcome = 'stubbed';
        this.routed.add(hop.id);
        this.extraRequests.push(hop);
        const stub = stubResponse(first);
        this.recordResponseFor(hop, stub.status, []);
        await route.fulfill({ status: stub.status, headers: stub.headers, body: stub.body });
        return;
      }
      if (!this.isSameOriginUrl(next.href)) break;
      this.extraRequests.push(hop);
      this.routed.add(hop.id);
      current = hop;
      try {
        response = await route.fetch({ url: next.href, method, postData: postData ?? undefined, maxRedirects: 0, timeout: 0 });
      } catch (error) {
        await route.abort(abortCode(error));
        return;
      }
      url = next.href;
      this.recordApiResponse(current, response);
    }
    await route.fulfill({ response });
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
    return record;
  }

  private recordResponseFor(record: Request, status: number, setCookieNames: string[]): void {
    this.responses.push({ type: 'response', id: newId('response'), requestId: record.id, status, setCookieNames });
  }

  private recordApiResponse(record: Request, response: APIResponse): void {
    const setCookieNames = response
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value.split('=')[0]!.trim());
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
    return {
      requests: [...this.requests.values(), ...this.extraRequests].filter((r) => r.stepId === step.id),
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
    const mainFrameEvents = this.dataLayerEvents.filter((e) => this.mainFrameEventIds.has(e.id));
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

  /** Closes the browser, decodes the requests and writes `<outDir>/<runId>.jsonl`. */
  async close(): Promise<RunResult> {
    if (this.options.networkMode !== 'live') await this.flushUnloadQueues();
    this.closed = true;
    await this.browser.close();
    await Promise.allSettled([...this.pending]);

    const requests = [...this.requests.values(), ...this.extraRequests];
    const hits: Hit[] = requests.flatMap((r) => decodeRequest(r));
    const flags = buildFlags({
      runId: this.runId,
      networkMode: this.options.networkMode,
      siteUrl: this.options.site,
      firstPartyHosts: this.options.firstPartyHosts,
      requests,
      hits,
      routedRequestIds: this.routed,
    });
    const consentEpochs = this.buildConsentEpochs();
    const records: RunRecords = {
      run: this.run,
      steps: this.steps,
      requests,
      responses: this.responses,
      hits,
      dataLayerEvents: this.dataLayerEvents,
      tagReports: [],
      consentEpochs,
      checkpoints: this.checkpoints,
      results: [],
      flags,
      collectorReports: this.collectorReports.filter((r): r is CollectorReport => r.type === 'collectorReport'),
      invalidReports: this.collectorReports.filter((r): r is InvalidReport => r.type === 'invalidReport'),
    };
    const writer = await RunWriter.create(this.options.outDir, this.run);
    try {
      for (const record of [
        ...requests,
        ...this.steps,
        ...this.checkpoints,
        ...this.responses,
        ...hits,
        ...this.dataLayerEvents,
        ...consentEpochs,
        ...this.collectorReports,
        ...flags,
      ]) {
        await writer.append(record);
      }
    } finally {
      await writer.close();
    }
    return { path: writer.path, records };
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
