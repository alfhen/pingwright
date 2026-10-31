import { randomUUID } from 'node:crypto';

export const HANDOFF_STATE_BINDING = '__pwHandoffState';
export const HANDOFF_DONE_BINDING = '__pwHandoffDone';
export const HANDOFF_HOST_ID = 'pingwright-handoff';
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
}

/** Waits for the first of the Done button and the terminal, and reminds the person in the terminal while it waits. */
export async function waitForHandoff(wait: HandoffWait): Promise<void> {
  const abort = new AbortController();
  const reminder = setInterval(() => wait.print(`Still waiting for the handoff: ${wait.text}`), wait.reminderMs ?? HANDOFF_REMINDER_MS);
  const fromButton = wait.gate.begin(wait.text);
  try {
    await Promise.race([fromButton, wait.resolver(wait.text, abort.signal)]);
  } finally {
    clearInterval(reminder);
    abort.abort();
    wait.gate.end();
  }
}

/**
 * Runs in the top frame of every document, never in a subframe. It stays dormant until the state binding
 * says a handoff is waiting. The pill lives in a closed shadow root and the Done click counts only when
 * trusted. The nonce stays in this closure, so a page script that calls the done binding is refused.
 */
export function handoffOverlayScript(nonce: string): string {
  return `(() => {
  if (window.top !== window) return;
  const NONCE = ${JSON.stringify(nonce)};
  const HOST_ID = ${JSON.stringify(HANDOFF_HOST_ID)};
  const stateFn = window[${JSON.stringify(HANDOFF_STATE_BINDING)}];
  const doneFn = window[${JSON.stringify(HANDOFF_DONE_BINDING)}];
  if (typeof stateFn !== 'function' || typeof doneFn !== 'function') return;
  const IMPORTANT = {
    all: 'initial', position: 'fixed', right: '16px', bottom: '16px', left: 'auto', top: 'auto',
    display: 'block', visibility: 'visible', opacity: '1', 'pointer-events': 'auto',
    width: 'max-content', 'max-width': '420px', height: 'auto', margin: '0', transform: 'none',
    'z-index': '2147483647',
  };
  const STOPPED = ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'mousedown', 'mouseup', 'mousemove', 'click', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'];
  let host = null;
  let label = null;
  let dropped = null;
  const apply = (el, styles) => { for (const k in styles) el.style.setProperty(k, styles[k], 'important'); };
  const build = () => {
    host = document.createElement('div');
    host.id = HOST_ID;
    apply(host, IMPORTANT);
    const root = host.attachShadow({ mode: 'closed' });
    const pill = document.createElement('div');
    label = document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Done';
    pill.append(label, button);
    root.append(pill);
    apply(pill, { display: 'flex', 'align-items': 'center', gap: '10px', padding: '6px 6px 6px 12px', background: '#1d2530', color: '#fff', font: '13px/1.3 system-ui, sans-serif', 'border-radius': '999px', 'box-shadow': '0 2px 10px rgba(0,0,0,.35)', cursor: 'grab', 'user-select': 'none', 'touch-action': 'none' });
    apply(label, { overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap', 'max-width': '300px' });
    apply(button, { all: 'unset', 'box-sizing': 'border-box', background: '#2f7d4f', color: '#fff', padding: '4px 14px', 'border-radius': '999px', 'font-weight': '600', cursor: 'pointer' });
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      Promise.resolve(doneFn(NONCE)).catch(() => {});
    });
    let grab = null;
    pill.addEventListener('pointerdown', (event) => {
      if (event.target === button) return;
      const box = host.getBoundingClientRect();
      grab = { dx: event.clientX - box.left, dy: event.clientY - box.top };
      pill.setPointerCapture(event.pointerId);
    });
    pill.addEventListener('pointermove', (event) => {
      if (!grab) return;
      const box = host.getBoundingClientRect();
      const left = Math.min(Math.max(0, event.clientX - grab.dx), Math.max(0, innerWidth - box.width));
      const top = Math.min(Math.max(0, event.clientY - grab.dy), Math.max(0, innerHeight - box.height));
      dropped = { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' };
      apply(host, dropped);
    });
    const release = () => { grab = null; };
    pill.addEventListener('pointerup', release);
    pill.addEventListener('pointercancel', release);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }');
      root.adoptedStyleSheets = [sheet];
    } catch {}
    const stop = (event) => event.stopPropagation();
    for (const type of STOPPED) {
      root.addEventListener(type, stop);
      host.addEventListener(type, stop);
    }
  };
  const show = (text) => {
    if (!host) build();
    label.textContent = text;
    label.title = text;
    apply(host, IMPORTANT);
    if (dropped) apply(host, dropped);
    const parent = document.documentElement;
    if (parent && host.parentNode !== parent) parent.append(host);
  };
  const hide = () => { if (host && host.parentNode) host.remove(); };
  const tick = async () => {
    let state;
    try { state = await stateFn(); } catch { return; }
    if (state && state.waiting) {
      show(String(state.text));
      return;
    }
    hide();
  };
  tick();
  setInterval(tick, 500);
})();`;
}
