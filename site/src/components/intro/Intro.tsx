import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  FLY_MS,
  INTRO_SEEN_KEY,
  MDELAYS,
  REPLAY_EVENT,
  SHAKE_FROM,
  SHRINK_MS,
  WASTED_AFTER_MS,
  WASTED_HOLD_MS,
  introFits,
  type IntroStage,
} from '../../lib/intro-data.ts';
import { Dock, MenuBar, SYSTEM_FONT } from './desktop.tsx';
import { MailWindow } from './mail.tsx';
import { Notifications, Wasted } from './overlays.tsx';
import { TagManagerWindow } from './tag-manager.tsx';

const SITE_IN = 'intro-site-in 1.1s cubic-bezier(.65,0,.35,1) both';
const notSite = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK']);

function markSeen(): void {
  try {
    localStorage.setItem(INTRO_SEEN_KEY, '1');
  } catch {
    // Without storage the intro shows again next time; the page still works.
  }
}

/** The page's own top-level elements: everything in <body> but the intro. */
function siteElements(intro: HTMLElement): HTMLElement[] {
  return [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.contains(intro) && !notSite.has(el.tagName));
}

/**
 * The handoff moves the site in as one wrapper with `transform-origin: 50% 30%`. The page has no such
 * wrapper, so each top-level element gets the origin of that shared point, which moves them as one.
 */
function moveSiteIn(site: HTMLElement[]): void {
  const originY = document.documentElement.scrollHeight * 0.3;
  for (const el of site) {
    const top = el.getBoundingClientRect().top + window.scrollY;
    el.style.transformOrigin = `50% ${originY - top}px`;
    el.style.animation = SITE_IN;
  }
}

export default function FirstVisitIntro() {
  const [stage, setStage] = useState<IntroStage | null>(null);
  const [shown, setShown] = useState(0);
  const [wastedSeen, setWastedSeen] = useState(false);
  const [selected, setSelected] = useState(1);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [attempt, setAttempt] = useState(1);
  const stageRef = useRef<IntroStage | null>(null);
  stageRef.current = stage;
  const timers = useRef<number[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);
  const siteRef = useRef<HTMLElement[]>([]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  const open = useCallback(() => {
    clearTimers();
    for (const el of siteRef.current) el.style.animation = '';
    window.scrollTo(0, 0);
    document.body.style.overflow = 'hidden';
    document.fonts?.load('1em Anton', 'wasted').catch(() => {});
    setStage('ask');
    setShown(0);
    setWastedSeen(false);
    setPreviewOpen(false);
  }, [clearTimers]);

  const fly = useCallback(() => {
    const from = stageRef.current;
    if (from === null || from === 'shrink' || from === 'fly') return;
    clearTimers();
    setStage('shrink');
    setPreviewOpen(false);
    setWastedSeen(from === 'wasted');
    markSeen();
    later(() => {
      setStage('fly');
      moveSiteIn(siteRef.current);
    }, SHRINK_MS);
    later(() => {
      document.body.style.overflow = '';
      setStage(null);
    }, SHRINK_MS + FLY_MS);
  }, [clearTimers, later]);

  const startMess = useCallback(() => {
    setStage('mess');
    setShown(0);
    let at = 0;
    MDELAYS.forEach((delay, i) => {
      at += delay;
      later(() => setShown(i + 1), at);
    });
    later(() => {
      setStage('wasted');
      setPreviewOpen(false);
    }, at + WASTED_AFTER_MS);
    later(fly, at + WASTED_AFTER_MS + WASTED_HOLD_MS);
  }, [fly, later]);

  useEffect(() => {
    if (document.documentElement.dataset.intro === 'pending') open();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') fly();
    };
    const onReplay = () => {
      if (introFits()) open();
    };
    window.addEventListener(REPLAY_EVENT, onReplay);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(REPLAY_EVENT, onReplay);
      window.removeEventListener('keydown', onKey);
      clearTimers();
      document.body.style.overflow = '';
    };
  }, [open, fly, clearTimers]);

  const isOpen = stage !== null;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!isOpen || !root) return;
    const returnFocus = document.activeElement;
    const site = siteElements(root);
    siteRef.current = site;
    for (const el of site) {
      el.inert = true;
      el.style.animation = '';
      el.style.transformOrigin = '';
    }
    document.documentElement.dataset.intro = 'open';
    root.focus({ preventScroll: true });
    return () => {
      for (const el of site) {
        el.inert = false;
        el.style.animation = '';
        el.style.transformOrigin = '';
      }
      delete document.documentElement.dataset.intro;
      if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    };
  }, [isOpen]);

  if (!stage) return null;

  const leaving = stage === 'shrink' || stage === 'fly';
  const messShowing = stage === 'mess' || stage === 'wasted' || (leaving && shown > 0);
  const wastedShowing = stage === 'wasted' || (leaving && wastedSeen);
  const transform = stage === 'fly' ? 'translateY(-105vh) scale(.84)' : stage === 'shrink' ? 'scale(.84)' : 'none';

  return (
    <div
      ref={rootRef}
      class="intro-root"
      role="dialog"
      aria-modal="true"
      aria-label="The 5-minute ticket"
      tabIndex={-1}
      data-intro-overlay
      data-stage={stage}
      style={`position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:100;overflow:hidden;outline:none;background:#0B0E12;transition:transform 1.1s cubic-bezier(.65,0,.35,1),opacity 1.1s ease-in,border-radius .7s,box-shadow .7s;transform:${transform};opacity:${stage === 'fly' ? 0.4 : 1};border-radius:${leaving ? '22px' : '0px'};box-shadow:${leaving ? '0 0 0 1px rgba(255,255,255,.08), 0 60px 120px -20px rgba(0,0,0,.8)' : 'none'}`}
    >
      <div
        class="intro-wallpaper"
        style={`position:absolute;inset:0;transition:filter 1.2s;filter:${wastedShowing ? 'grayscale(1) contrast(1.15) brightness(.8)' : 'none'};animation:${wastedShowing ? 'intro-slow-zoom 4s ease-out both' : 'none'};transform-origin:60% 40%;font-family:${SYSTEM_FONT}`}
      >
        <MenuBar app={stage === 'ask' ? 'Mail' : 'TagMangler Pro'} unread={1 + shown} shown={shown} onSkip={fly} />
        <Dock browserOpen={stage !== 'ask'} />
        <MailWindow asking={stage === 'ask'} shown={shown} unread={1 + shown} onReply={startMess} onSkip={fly} />
        {messShowing && (
          <TagManagerWindow
            shaking={stage === 'mess' && shown >= SHAKE_FROM}
            shown={shown}
            selected={selected}
            onSelect={setSelected}
            previewOpen={previewOpen && stage === 'mess'}
            attempt={attempt}
            onPreview={() => setPreviewOpen(true)}
            onCancelPreview={() => setPreviewOpen(false)}
            onRetryPreview={() => setAttempt((n) => n + 1)}
          />
        )}
        <Notifications shown={shown} />
      </div>
      {wastedShowing && <Wasted />}
    </div>
  );
}
