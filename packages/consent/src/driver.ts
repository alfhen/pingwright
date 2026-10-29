import type { BrowserContext, Frame, Page } from 'playwright';
import { bundledRules, contentScriptSource, fixtureRulesPath, mergeRules, readRuleFile } from './rules.ts';

export type BannerAction = 'accept' | 'reject' | 'none';

export interface BannerResult {
  detected: boolean;
  shown: boolean;
  cmp: string | null;
  action: BannerAction;
  result: 'ok' | 'failed' | 'banner not shown';
  /** Why the result is not `ok`, when known. */
  note?: string;
  /** Epoch milliseconds on the page clock when the action reached the page, or when the wait ended for `none` and failures. */
  t: number;
  /** Epoch milliseconds, taken when the action's result arrived. Equals `t` for `none` and failures. */
  tEnd: number;
}

export interface ConsentOptions {
  /**
   * Rule files to load besides the bundled rules and the fixture-site rules. A rule with the name of a
   * bundled rule replaces it. A rule with another name for the same banner does not take priority;
   * turn the bundled one off with `disabledCmps`.
   */
  ruleFiles?: string[];
  /** Load rules/fixture-site.json. Default true. */
  fixtureRules?: boolean;
  /** How many times autoconsent retries CMP detection. */
  detectRetries?: number;
  /** Names of autoconsent rules to turn off. */
  disabledCmps?: string[];
}

export interface AnswerOptions extends ConsentOptions {
  timeoutMs?: number;
}

interface ContentMessage {
  type: string;
  cmp?: string;
  result?: boolean;
  id?: string;
  code?: string;
}

interface FrameState {
  detected: boolean;
  cmp: string | null;
  shownT: number | null;
  /** An action used up the popup report; the banner must be detected again before the next answer. */
  acted: boolean;
  /** When autoconsent's detection last started in this frame; 0 until the content script has initialised. */
  detectT: number;
  resultSeq: number;
  result: boolean | null;
}

export class ConsentDriver {
  readonly #frames = new WeakMap<Frame, FrameState>();
  readonly #listeners = new Set<() => void>();
  readonly #rules: string;
  readonly #config: string;
  readonly #detectWindowMs: number;
  readonly options: Required<ConsentOptions>;

  constructor(options: ConsentOptions) {
    this.options = {
      ruleFiles: options.ruleFiles ?? [],
      fixtureRules: options.fixtureRules !== false,
      detectRetries: options.detectRetries ?? 10,
      disabledCmps: options.disabledCmps ?? [],
    };
    const extra = [
      ...(options.fixtureRules === false ? [] : readRuleFile(fixtureRulesPath)),
      ...(options.ruleFiles ?? []).flatMap(readRuleFile),
    ];
    const rules = mergeRules(extra, bundledRules());
    this.#rules = JSON.stringify({ autoconsent: rules });
    this.#detectWindowMs = (options.detectRetries ?? 10) * 500 + 1000;
    this.#config = JSON.stringify({
      enabled: true,
      autoAction: null,
      disabledCmps: options.disabledCmps ?? [],
      enablePrehide: false,
      enableCosmeticRules: false,
      detectRetries: options.detectRetries ?? 10,
    });
  }

  async install(context: BrowserContext): Promise<void> {
    await context.exposeBinding('autoconsentSendMessage', (source, msg: ContentMessage) =>
      this.#onMessage(source.frame, msg),
    );
    const source = contentScriptSource();
    await context.addInitScript({ content: source });
    // The init script only reaches documents that load later; inject into the ones already open.
    const frames = context.pages().flatMap((page) => page.frames());
    await Promise.all(frames.map((frame) => frame.evaluate(source).catch(() => {})));
  }

  /** True once autoconsent's content script has started in the frame. */
  isRunningIn(frame: Frame): boolean {
    return (this.#frames.get(frame)?.detectT ?? 0) > 0;
  }

  async #onMessage(frame: Frame, msg: ContentMessage): Promise<void> {
    const state = this.#state(frame);
    switch (msg.type) {
      case 'init':
        this.#frames.set(frame, {
          detected: false,
          cmp: null,
          shownT: null,
          acted: false,
          detectT: Date.now(),
          resultSeq: 0,
          result: null,
        });
        await frame
          .evaluate(`autoconsentReceiveMessage({ type: 'initResp', config: ${this.#config}, rules: ${this.#rules} })`)
          .catch(() => {});
        this.#notify();
        return;
      case 'cmpDetected':
        state.detected = true;
        state.cmp = msg.cmp ?? null;
        break;
      case 'popupFound':
        if (state.shownT === null) state.cmp = msg.cmp ?? state.cmp;
        state.shownT = Date.now();
        break;
      case 'optInResult':
      case 'optOutResult':
        state.resultSeq += 1;
        state.result = msg.result ?? false;
        break;
      case 'eval': {
        const result = await frame.evaluate(msg.code ?? 'false').catch(() => false);
        await frame
          .evaluate(
            `autoconsentReceiveMessage({ id: ${JSON.stringify(msg.id)}, type: 'evalResp', result: ${JSON.stringify(result)} })`,
          )
          .catch(() => {});
        return;
      }
      default:
        return;
    }
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #state(frame: Frame): FrameState {
    let state = this.#frames.get(frame);
    if (!state) {
      state = { detected: false, cmp: null, shownT: null, acted: false, detectT: 0, resultSeq: 0, result: null };
      this.#frames.set(frame, state);
    }
    return state;
  }

  async #waitUntil<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const found = find();
    if (found !== undefined) return found;
    return new Promise((resolve) => {
      const done = (value: T | undefined) => {
        clearTimeout(timer);
        this.#listeners.delete(check);
        resolve(value);
      };
      const check = () => {
        const value = find();
        if (value !== undefined) done(value);
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      this.#listeners.add(check);
    });
  }

  #shownFrame(frames: () => Frame[]): Frame | undefined {
    let best: { frame: Frame; shownT: number } | undefined;
    for (const frame of frames()) {
      const shownT = this.#frames.get(frame)?.shownT;
      if (shownT != null && (!best || shownT > best.shownT)) best = { frame, shownT };
    }
    return best?.frame;
  }

  // Autoconsent reports a popup once per document and gives up looking after its detection
  // retries. Running detection again (rules are already loaded, so none are sent) reports a
  // banner that opened later, or that was reopened after an action.
  async #redetect(frames: Frame[]): Promise<void> {
    const now = Date.now();
    await Promise.all(
      frames.map(async (frame) => {
        const state = this.#frames.get(frame);
        if (!state?.detectT || state.shownT != null) return;
        if (!state.acted && now - state.detectT < this.#detectWindowMs) return;
        state.acted = false;
        state.detectT = now;
        await frame
          .evaluate(`autoconsentReceiveMessage({ type: 'initResp', config: ${this.#config}, rules: null })`)
          .catch(() => {});
      }),
    );
  }

  async #waitForBanner(frames: () => Frame[], timeoutMs: number): Promise<Frame | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.#redetect(frames());
      const remaining = deadline - Date.now();
      const found = await this.#waitUntil(() => this.#shownFrame(frames), Math.max(0, Math.min(remaining, 1000)));
      if (found || remaining <= 1000) return found;
    }
  }

  async answer(target: Page | BrowserContext, action: BannerAction, timeoutMs: number): Promise<BannerResult> {
    const frames = () => ('frames' in target ? target.frames() : target.pages().flatMap((p) => p.frames()));
    const shownFrame = await this.#waitForBanner(frames, timeoutMs);
    if (!shownFrame) {
      const now = Date.now();
      const running = frames().some((f) => this.isRunningIn(f));
      const detected = frames().map((f) => this.#frames.get(f)).filter((s) => s?.detected);
      return {
        detected: detected.length > 0,
        shown: false,
        cmp: detected[0]?.cmp ?? null,
        action,
        result: 'banner not shown',
        ...(running ? {} : { note: 'autoconsent did not start in any frame' }),
        t: now,
        tEnd: now,
      };
    }
    const state = this.#state(shownFrame);
    const base = { detected: true, shown: true, cmp: state.cmp, action };
    if (action === 'none') return { ...base, result: 'ok', t: state.shownT ?? Date.now(), tEnd: state.shownT ?? Date.now() };

    const before = state.resultSeq;
    state.shownT = null;
    state.acted = true;
    // Autoconsent keeps its detected CMP after a first action, so a later message can act again.
    const message = action === 'accept' ? 'optIn' : 'optOut';
    let t: number;
    try {
      t = (await shownFrame.evaluate(
        `(() => { autoconsentReceiveMessage({ type: '${message}' }); return performance.timeOrigin + performance.now(); })()`,
      )) as number;
    } catch {
      const failedT = Date.now();
      return { ...base, result: 'failed', note: 'the action could not be sent to the page', t: failedT, tEnd: failedT };
    }
    // A navigation replaces the frame's state, so read it afresh and stop waiting once it changes.
    const reported = await this.#waitUntil(() => {
      const current = this.#frames.get(shownFrame);
      if (current !== state) return false;
      return state.resultSeq > before ? state.result : undefined;
    }, timeoutMs);
    return {
      ...base,
      result: reported ? 'ok' : 'failed',
      ...(reported ? {} : { note: 'autoconsent reported no successful result' }),
      t,
      tEnd: Date.now(),
    };
  }
}

const drivers = new WeakMap<BrowserContext, ConsentDriver>();

/** Installs the content script in every page of the context, including frames that are already open. */
export async function installConsent(context: BrowserContext, options: ConsentOptions = {}): Promise<ConsentDriver> {
  const existing = drivers.get(context);
  if (existing) {
    assertSameOptions(existing, options);
    return existing;
  }
  const driver = new ConsentDriver(options);
  drivers.set(context, driver);
  await driver.install(context);
  return driver;
}

function assertSameOptions(driver: ConsentDriver, options: ConsentOptions): void {
  for (const key of ['ruleFiles', 'fixtureRules', 'detectRetries', 'disabledCmps'] as const) {
    const wanted = options[key];
    if (wanted !== undefined && JSON.stringify(wanted) !== JSON.stringify(driver.options[key])) {
      throw new Error(
        `Consent is already installed on this context with a different "${key}" option; set options once in installConsent`,
      );
    }
  }
}

export async function answerBanner(
  target: Page | BrowserContext,
  action: BannerAction,
  options: AnswerOptions = {},
): Promise<BannerResult> {
  const context = 'context' in target && typeof target.context === 'function' ? target.context() : (target as BrowserContext);
  const driver = await installConsent(context, options);
  return driver.answer(target, action, options.timeoutMs ?? 10_000);
}
