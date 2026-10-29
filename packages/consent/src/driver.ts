import type { BrowserContext, Frame, Page } from 'playwright';
import { bundledRules, contentScriptSource, fixtureRulesPath, readRuleFile, type Rule } from './rules.ts';

export type BannerAction = 'accept' | 'reject' | 'none';

export interface BannerResult {
  detected: boolean;
  shown: boolean;
  cmp: string | null;
  action: BannerAction;
  result: 'ok' | 'failed' | 'banner not shown';
  /** Epoch milliseconds, taken just before the action is sent, or when the wait ended for `none` and failures. */
  t: number;
}

export interface ConsentOptions {
  /** Rule files to load besides the bundled rules and the fixture-site rules. */
  ruleFiles?: string[];
  /** Load rules/fixture-site.json. Default true. */
  fixtureRules?: boolean;
  /** How many times autoconsent retries CMP detection. */
  detectRetries?: number;
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
  resultSeq: number;
  result: boolean | null;
}

export class ConsentDriver {
  readonly #frames = new WeakMap<Frame, FrameState>();
  readonly #listeners = new Set<() => void>();
  readonly #rules: string;
  readonly #config: string;

  constructor(options: ConsentOptions) {
    const extra = [
      ...(options.fixtureRules === false ? [] : readRuleFile(fixtureRulesPath)),
      ...(options.ruleFiles ?? []).flatMap(readRuleFile),
    ];
    // Extra rules go first so a user rule wins over a bundled rule for the same banner.
    const rules: Rule[] = [...extra, ...bundledRules()];
    this.#rules = JSON.stringify({ autoconsent: rules });
    this.#config = JSON.stringify({
      enabled: true,
      autoAction: null,
      disabledCmps: [],
      enablePrehide: false,
      enableCosmeticRules: false,
      detectRetries: options.detectRetries ?? 10,
    });
  }

  async install(context: BrowserContext): Promise<void> {
    await context.exposeBinding('autoconsentSendMessage', (source, msg: ContentMessage) =>
      this.#onMessage(source.frame, msg),
    );
    await context.addInitScript({ content: contentScriptSource() });
  }

  async #onMessage(frame: Frame, msg: ContentMessage): Promise<void> {
    const state = this.#state(frame);
    switch (msg.type) {
      case 'init':
        this.#frames.set(frame, { detected: false, cmp: null, shownT: null, acted: false, resultSeq: 0, result: null });
        await frame
          .evaluate(`autoconsentReceiveMessage({ type: 'initResp', config: ${this.#config}, rules: ${this.#rules} })`)
          .catch(() => {});
        return;
      case 'cmpDetected':
        state.detected = true;
        state.cmp = msg.cmp ?? null;
        break;
      case 'popupFound':
        state.shownT = Date.now();
        state.cmp = msg.cmp ?? state.cmp;
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
    for (const listener of this.#listeners) listener();
  }

  #state(frame: Frame): FrameState {
    let state = this.#frames.get(frame);
    if (!state) {
      state = { detected: false, cmp: null, shownT: null, acted: false, resultSeq: 0, result: null };
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

  // Autoconsent reports a popup once per document and ignores a reopened banner. Running its
  // detection again (rules are already loaded, so none are sent) reports a banner that is open now.
  async #redetect(frames: Frame[]): Promise<void> {
    await Promise.all(
      frames.map(async (frame) => {
        const state = this.#frames.get(frame);
        if (!state?.acted) return;
        state.acted = false;
        await frame
          .evaluate(`autoconsentReceiveMessage({ type: 'initResp', config: ${this.#config}, rules: null })`)
          .catch(() => {});
      }),
    );
  }

  async answer(target: Page | BrowserContext, action: BannerAction, timeoutMs: number): Promise<BannerResult> {
    const frames = () => ('frames' in target ? target.frames() : target.pages().flatMap((p) => p.frames()));
    await this.#redetect(frames());
    const shownFrame = await this.#waitUntil(() => this.#shownFrame(frames), timeoutMs);
    if (!shownFrame) {
      const detected = frames().map((f) => this.#frames.get(f)).filter((s) => s?.detected);
      return {
        detected: detected.length > 0,
        shown: false,
        cmp: detected[0]?.cmp ?? null,
        action,
        result: 'banner not shown',
        t: Date.now(),
      };
    }
    const state = this.#state(shownFrame);
    const base = { detected: true, shown: true, cmp: state.cmp, action };
    if (action === 'none') return { ...base, result: 'ok', t: state.shownT ?? Date.now() };

    const before = state.resultSeq;
    const t = Date.now();
    state.shownT = null;
    state.acted = true;
    // Autoconsent keeps its detected CMP after a first action, so a later message can act again.
    const message = action === 'accept' ? 'optIn' : 'optOut';
    try {
      await shownFrame.evaluate(`autoconsentReceiveMessage({ type: '${message}' })`);
    } catch {
      return { ...base, result: 'failed', t };
    }
    const reported = await this.#waitUntil(() => (state.resultSeq > before ? state.result : undefined), 5000);
    return { ...base, result: reported ? 'ok' : 'failed', t };
  }
}

const drivers = new WeakMap<BrowserContext, ConsentDriver>();

/** Install before pages are created: the content script reaches only frames that load afterwards. */
export async function installConsent(context: BrowserContext, options: ConsentOptions = {}): Promise<ConsentDriver> {
  const existing = drivers.get(context);
  if (existing) return existing;
  const driver = new ConsentDriver(options);
  drivers.set(context, driver);
  await driver.install(context);
  return driver;
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
