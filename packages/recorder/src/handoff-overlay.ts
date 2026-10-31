import { randomUUID } from 'node:crypto';

export const HANDOFF_STATE_BINDING = '__pwHandoffState';
export const HANDOFF_DONE_BINDING = '__pwHandoffDone';
export const HANDOFF_HOST_ID = 'pingwright-handoff';
export const HANDOFF_WAKE_EVENT = 'pingwright-handoff-wake';
export const HANDOFF_REMINDER_MS = 60_000;

export interface HandoffState {
  waiting: boolean;
  text: string;
}

/** Holds the handoff that is waiting, and ends it only for a caller that knows the per-run nonce. */
export class HandoffGate {
  readonly nonce = randomUUID();
  private text: string | null = null;
  private finish: (() => void) | null = null;

  begin(text: string): Promise<void> {
    this.text = text;
    return new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  end(): void {
    this.text = null;
    this.finish = null;
  }

  state(): HandoffState {
    return { waiting: this.text !== null, text: this.text ?? '' };
  }

  done(nonce: unknown): boolean {
    if (typeof nonce !== 'string' || nonce !== this.nonce || !this.finish) return false;
    this.finish();
    return true;
  }
}

export interface HandoffWait {
  text: string;
  gate: HandoffGate;
  /** Ends when the person presses Enter. Must stop when the signal aborts. */
  resolver: (text: string, signal: AbortSignal) => Promise<void>;
  print: (text: string) => void;
  reminderMs?: number;
  /** Called once the gate is open, so a document whose polling stopped asks for the state again. */
  wake?: () => Promise<void>;
}

/** Waits for the first of the Done button and the terminal, and reminds the person in the terminal while it waits. */
export async function waitForHandoff(wait: HandoffWait): Promise<void> {
  const abort = new AbortController();
  const reminder = setInterval(() => wait.print(`Still waiting for the handoff: ${wait.text}`), wait.reminderMs ?? HANDOFF_REMINDER_MS);
  const fromButton = wait.gate.begin(wait.text);
  try {
    await wait.wake?.().catch(() => undefined);
    await Promise.race([fromButton, wait.resolver(wait.text, abort.signal)]);
  } finally {
    clearInterval(reminder);
    abort.abort();
    wait.gate.end();
  }
}

/**
 * Runs in the top frame of every document, never in a subframe. It stays dormant until the state binding
 * says a handoff is waiting. It polls while one is waiting and stops when none is, until the wake event.
 * The pill lives in a closed shadow root and the Done click counts only when trusted. The nonce stays in
 * this closure, so a page script that calls the done binding is refused. The pill and its listeners are
 * built at document start, before page scripts run. The DOM accessors, the event getters and
 * stopPropagation are captured then too and called without Function.prototype.call, so a page that patches
 * those members, or call, never sees the pill. The pill is capped at the viewport width minus 32px.
 * A page script can still move the host, restyle it, cover it or remove it. A person's real click on Done
 * (or Enter in the terminal) is what ends the wait.
 */
export function handoffOverlayScript(nonce: string): string {
  return `(() => {
  if (window.top !== window) return;
  const NONCE = ${JSON.stringify(nonce)};
  const HOST_ID = ${JSON.stringify(HANDOFF_HOST_ID)};
  const WAKE = ${JSON.stringify(HANDOFF_WAKE_EVENT)};
  const stateFn = window[${JSON.stringify(HANDOFF_STATE_BINDING)}];
  const doneFn = window[${JSON.stringify(HANDOFF_DONE_BINDING)}];
  if (typeof stateFn !== 'function' || typeof doneFn !== 'function') return;
  const IMPORTANT = {
    all: 'initial', position: 'fixed', right: '16px', bottom: '16px', left: 'auto', top: 'auto',
    display: 'block', visibility: 'visible', opacity: '1', 'pointer-events': 'auto',
    width: 'max-content', 'max-width': 'min(420px, calc(100vw - 32px))', height: 'auto', margin: '0', transform: 'none',
    'z-index': '2147483647',
  };
  const STOPPED = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'];
  let host = null;
  let label = null;
  let dropped = null;
  const uncurry = Function.prototype.bind.bind(Function.prototype.call);
  const addListener = uncurry(EventTarget.prototype.addEventListener);
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const setter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).set;
  const setText = uncurry(setter(Node.prototype, 'textContent'));
  const setTitle = uncurry(setter(HTMLElement.prototype, 'title'));
  const getStyle = uncurry(getter(HTMLElement.prototype, 'style'));
  const setProp = uncurry(CSSStyleDeclaration.prototype.setProperty);
  const appendChild = uncurry(Element.prototype.append);
  const appendToRoot = uncurry(DocumentFragment.prototype.append);
  const removeNode = uncurry(Element.prototype.remove);
  const getRoot = uncurry(getter(Document.prototype, 'documentElement'));
  const getParent = uncurry(getter(Node.prototype, 'parentNode'));
  const getBox = uncurry(Element.prototype.getBoundingClientRect);
  const getTarget = uncurry(getter(Event.prototype, 'target'));
  const getX = uncurry(getter(MouseEvent.prototype, 'clientX'));
  const getY = uncurry(getter(MouseEvent.prototype, 'clientY'));
  const getPointerId = uncurry(getter(PointerEvent.prototype, 'pointerId'));
  const stopPropagation = uncurry(Event.prototype.stopPropagation);
  const capture = uncurry(Element.prototype.setPointerCapture);
  const trustedOf = uncurry(Object.getOwnPropertyDescriptor(new Event('x'), 'isTrusted').get);
  const trusted = (event) => { try { return trustedOf(event) === true; } catch { return false; } };
  const apply = (el, styles) => { const style = getStyle(el); for (const k in styles) setProp(style, k, styles[k], 'important'); };
  const build = () => {
    host = document.createElement('div');
    host.id = HOST_ID;
    apply(host, IMPORTANT);
    const root = host.attachShadow({ mode: 'closed' });
    const pill = document.createElement('div');
    label = document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    setText(button, 'Done');
    appendChild(pill, label, button);
    appendToRoot(root, pill);
    apply(pill, { display: 'flex', 'align-items': 'center', gap: '10px', padding: '6px 6px 6px 12px', background: '#1d2530', color: '#fff', font: '13px/1.3 system-ui, sans-serif', 'border-radius': '999px', 'box-sizing': 'border-box', 'max-width': '100%', 'box-shadow': '0 2px 10px rgba(0,0,0,.35)', cursor: 'grab', 'user-select': 'none', 'touch-action': 'none' });
    apply(label, { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'max-width': '300px', 'min-width': '0' });
    apply(button, { all: 'unset', 'box-sizing': 'border-box', background: '#2f7d4f', color: '#fff', padding: '4px 14px', 'border-radius': '999px', 'font-weight': '600', cursor: 'pointer', 'flex-shrink': '0' });
    addListener(button, 'click', (event) => {
      if (!trusted(event)) return;
      Promise.resolve(doneFn(NONCE)).catch(() => {});
    });
    let grab = null;
    addListener(pill, 'pointerdown', (event) => {
      if (getTarget(event) === button) return;
      const box = getBox(host);
      grab = { dx: getX(event) - box.left, dy: getY(event) - box.top };
      capture(pill, getPointerId(event));
    });
    addListener(pill, 'pointermove', (event) => {
      if (!grab) return;
      const box = getBox(host);
      const left = Math.min(Math.max(0, getX(event) - grab.dx), Math.max(0, innerWidth - box.width));
      const top = Math.min(Math.max(0, getY(event) - grab.dy), Math.max(0, innerHeight - box.height));
      dropped = { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
      apply(host, dropped);
    });
    const release = () => { grab = null; };
    addListener(pill, 'pointerup', release);
    addListener(pill, 'pointercancel', release);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }');
      root.adoptedStyleSheets = [sheet];
    } catch {}
    const stop = (event) => stopPropagation(event);
    for (const type of STOPPED) {
      addListener(root, type, stop);
      addListener(host, type, stop);
    }
  };
  const show = (text) => {
    setText(label, text);
    setTitle(label, text);
    apply(host, IMPORTANT);
    if (dropped) apply(host, dropped);
    const parent = getRoot(document);
    if (parent && getParent(host) !== parent) appendChild(parent, host);
  };
  const hide = () => { if (host && getParent(host)) removeNode(host); };
  let timer = null;
  const stopPolling = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
  const tick = async () => {
    let state;
    try { state = await stateFn(); } catch { return; }
    if (state && state.waiting) {
      show(String(state.text));
      return;
    }
    hide();
    stopPolling();
  };
  const start = () => {
    if (timer === null) timer = setInterval(tick, 500);
    tick();
  };
  build();
  addListener(window, WAKE, start);
  start();
})();`;
}
