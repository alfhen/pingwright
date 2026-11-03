/** Copy, timings and the show rule for the first-visit intro, from the handoff's `demo-data.js`. */

export const INTRO_SEEN_KEY = 'tagreeve.introSeen';
export const INTRO_MIN_WIDTH = 860;
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const REPLAY_EVENT = 'tagreeve:replay-intro';

export type IntroStage = 'ask' | 'mess' | 'wasted' | 'shrink' | 'fly';

/** Each notification arrives this many ms after the one before it. */
export const MDELAYS = [1300, 1100, 950, 800, 650, 520, 420, 340, 270, 220, 180, 150, 130];
export const WASTED_AFTER_MS = 600;
export const WASTED_HOLD_MS = 2400;
export const SHRINK_MS = 750;
export const FLY_MS = 1150;
/** The window shakes from this notification on. */
export const SHAKE_FROM = 10;

/** left, top, rotation for notifications after the first four. */
export const SCATTER: readonly (readonly [string, string, string])[] = [
  ['8%', '22%', '-3deg'],
  ['34%', '58%', '2deg'],
  ['52%', '14%', '-1deg'],
  ['14%', '64%', '4deg'],
  ['40%', '32%', '-5deg'],
  ['62%', '70%', '3deg'],
  ['22%', '42%', '-2deg'],
  ['48%', '48%', '6deg'],
  ['6%', '80%', '-4deg'],
  ['30%', '8%', '2deg'],
  ['56%', '38%', '-6deg'],
  ['18%', '30%', '5deg'],
  ['44%', '76%', '-3deg'],
];

interface Person {
  who: string;
  role: string;
  initial: string;
  color: string;
}

const MADS: Person = { who: 'Mads', role: 'Performance', initial: 'M', color: '#2F6FD6' };
const SOFIE: Person = { who: 'Sofie', role: 'Legal', initial: 'S', color: '#7A5AF8' };
const JONAS: Person = { who: 'Jonas', role: 'Dev', initial: 'J', color: '#0E9384' };
const KARIN: Person = { who: 'Karin', role: 'CMO', initial: 'K', color: '#C4320A' };
const DPO: Person = { who: 'Henrik', role: 'DPO', initial: 'H', color: '#475467' };
const AGENCY: Person = { who: 'Pixel & Co', role: 'Agency', initial: 'P', color: '#DD2590' };

export interface Notification extends Person {
  text: string;
  channel: 'mail' | 'chat';
  /** The inbox subject, for mail notifications. */
  subject: string;
}

const note = (person: Person, channel: 'mail' | 'chat', text: string, subject = text): Notification => ({ ...person, channel, text, subject });

/** One notification per delay in MDELAYS, in order. */
export const NOTIFICATIONS: readonly Notification[] = [
  note(SOFIE, 'mail', 'Three complaints this week saying Meta loads before people answer the cookie banner.', 'FW: Complaint re. cookies'),
  note(JONAS, 'chat', "I didn't touch GTM. Maybe the agency's pixel?"),
  note(MADS, 'chat', 'Any luck? The ROAS dashboard is all red.'),
  note(SOFIE, 'mail', 'Looping in our DPO.', 'Consent audit, DPO cc'),
  note(AGENCY, 'mail', "We didn't change anything. Have you tried clearing your cache?", 'RE: RE: pixel'),
  note(KARIN, 'chat', 'Is this fixed?'),
  note(DPO, 'mail', 'Please send a list of every vendor that gets data before consent. Today.', 'URGENT: vendor list'),
  note(JONAS, 'chat', "Preview mode doesn't load for me either"),
  note(MADS, 'chat', '??'),
  note(KARIN, 'chat', 'Board meeting in 20 minutes.'),
  note(SOFIE, 'mail', 'A customer has complained to the data protection authority.', 'Complaint to the authority'),
  note(MADS, 'chat', 'hello?'),
  note(AGENCY, 'mail', 'Our invoice for the "consent fix" is attached', 'Invoice #2302'),
];

export interface PlacedNotification extends Notification {
  x: string;
  y: string;
  rotate: string;
}

/** The first four stack at the top right, the rest scatter. */
export function placeNotifications(shown: number): PlacedNotification[] {
  return NOTIFICATIONS.slice(0, shown).map((n, i) => {
    if (i < 4) return { ...n, x: 'calc(100% - 340px)', y: `${42 + i * 88}px`, rotate: '0deg' };
    const [x, y, rotate] = SCATTER[(i - 4) % SCATTER.length]!;
    return { ...n, x, y, rotate };
  });
}

export interface MailItem {
  from: string;
  subject: string;
  preview: string;
  time: string;
  unread: boolean;
  open: boolean;
  arrived: boolean;
}

const INBOX: readonly MailItem[] = [
  { from: 'Mads Holm', subject: 'Quick favour? Meta numbers + consent', preview: 'Sorry to bother you. Meta numbers fell off a cliff…', time: '16:47', unread: true, open: true, arrived: false },
  { from: 'Sofie (Legal)', subject: 'RE: Consent complaints (3)', preview: 'Forwarding the latest one from a customer…', time: '14:02', unread: false, open: false, arrived: false },
  { from: 'Pixel & Co', subject: 'Invoice #2291 · "Consent fix"', preview: 'Please find attached our invoice for…', time: '11:30', unread: false, open: false, arrived: false },
  { from: 'Office', subject: 'Cake on Friday!', preview: "It's Jonas's birthday, so…", time: 'Wed', unread: false, open: false, arrived: false },
  { from: 'GTM Weekly', subject: '10 tags you should delete today', preview: 'Number 7 will surprise you…', time: 'Tue', unread: false, open: false, arrived: false },
];

/** Mail notifications land on top of the inbox, newest first. */
export function mailList(shown: number): MailItem[] {
  const arrived = NOTIFICATIONS.slice(0, shown)
    .filter((n) => n.channel === 'mail')
    .reverse()
    .map((n) => ({ from: n.who, subject: n.subject, preview: n.text, time: 'now', unread: true, open: false, arrived: true }));
  return [...arrived, ...INBOX];
}

/** Minutes on the ticket grow with the square of the notifications shown. */
const minutesAfter = (shown: number): number => Math.round(shown * shown * 1.15);

export function deskClock(shown: number): string {
  const total = 16 * 60 + 47 + minutesAfter(shown);
  return `Thu ${Math.floor(total / 60) % 24}:${String(total % 60).padStart(2, '0')}`;
}

export const battery = (shown: number): string => `${Math.max(8, 80 - shown * 4)}%`;

export function timeSpent(shown: number): string {
  const m = 5 + minutesAfter(shown);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function wastedLine(): string {
  const m = 5 + minutesAfter(MDELAYS.length);
  return `${Math.floor(m / 60)}h ${m % 60}m in the tag manager. Meta still fires before consent.`;
}

export interface BrowserTab {
  title: string;
  icon: string;
  radius: string;
  active?: boolean;
}

export const BROWSER_TABS: readonly BrowserTab[] = [
  { title: 'Tags · TagMangler', active: true, icon: '#5F6B7A', radius: '3px' },
  { title: 'Events Manager · Ads', icon: '#4A7BD0', radius: '50%' },
  { title: 'consent_audit (2).xlsx', icon: '#2E8B57', radius: '3px' },
  { title: 'why does consent mode not work - Search', icon: '#9aa0a6', radius: '50%' },
  { title: 'Consent banner settings', icon: '#C77D2E', radius: '50%' },
];

export const ACCOUNT_NAME = 'Northwind Retail';
export const CONTAINER_HOST = 'www.northwind.example';

export interface Tag {
  name: string;
  type: string;
  trig: string;
  ago: string;
  consent: string;
  note: string;
}

export const TAGS: readonly Tag[] = [
  { name: 'FB Pixel - OLD - do not delete', type: 'Custom HTML', trig: 'All Pages', ago: '3 yrs', consent: 'Not set', note: '"Removing this broke something in 2023" — K.' },
  { name: 'Meta CAPI v2 (copy) (copy)', type: 'Custom HTML', trig: 'DOM Ready - ALL', ago: '2 days', consent: 'Not set', note: 'Which copy is live? Both, apparently.' },
  { name: 'Meta - Purchase NEW', type: 'Template', trig: 'ce - purchase_v2', ago: '2 days', consent: 'ad_storage (maybe)', note: 'Is the email lowercased before hashing? Nobody knows.' },
  { name: 'GA4 config (Jonas test)', type: 'GA4 Config', trig: 'All Pages', ago: '5 mo', consent: 'Built-in', note: 'Test tag. In production.' },
  { name: 'consent fix?? 14.03', type: 'Custom HTML', trig: 'Consent Init - All', ago: '8 mo', consent: 'n/a', note: 'Sets ad_storage to granted. "TODO revert".' },
  { name: 'GAds Remarketing', type: 'Google Ads', trig: 'All Pages', ago: '1 yr', consent: 'Built-in', note: '' },
  { name: 'Pinterest base (agency)', type: 'Custom HTML', trig: 'Window Loaded', ago: '2 yrs', consent: 'Not set', note: 'Agency left in 2024.' },
  { name: 'CookieBanner listener v4 FINAL', type: 'Custom HTML', trig: 'Initialization', ago: '8 mo', consent: 'n/a', note: 'v5 is in "Unsorted".' },
  { name: 'Meta AddToCart (dupe?)', type: 'Template', trig: 'Click - Add btn', ago: '2 days', consent: 'Not set', note: '' },
  { name: 'TikTok – paused?', type: 'Custom HTML', trig: '—', ago: '1 yr', consent: 'Not set', note: '' },
  { name: 'sGTM forwarder (Stape)', type: 'GA4 Event', trig: 'All Events', ago: '6 mo', consent: 'Built-in', note: '' },
  { name: 'zz_temp_hotjar', type: 'Custom HTML', trig: 'All Pages', ago: '4 yrs', consent: 'Not set', note: '' },
  { name: 'Meta ViewContent', type: 'Template', trig: 'PDP - all', ago: '2 days', consent: 'Not set', note: '' },
  { name: 'LinkedIn Insight', type: 'Custom HTML', trig: 'All Pages', ago: '3 yrs', consent: 'Not set', note: '' },
  { name: 'Meta Lead (old form)', type: 'Custom HTML', trig: 'Form Submit', ago: '2 yrs', consent: 'Not set', note: '' },
  { name: 'Reddit pixel test', type: 'Custom HTML', trig: 'All Pages', ago: '7 mo', consent: 'Not set', note: '' },
];

/** Whether this window may play the intro, on the first visit and on replay alike. */
export function introFits(win: Pick<Window, 'innerWidth' | 'matchMedia'> = window): boolean {
  return win.innerWidth >= INTRO_MIN_WIDTH && !win.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The same rule as `introFits`, for the inline gate script, which cannot import it. */
const introFitsSource = `window.innerWidth >= ${INTRO_MIN_WIDTH} && !window.matchMedia(${JSON.stringify(REDUCED_MOTION_QUERY)}).matches`;

/**
 * Runs inline in the page before the first paint. It marks `<html data-intro="pending">` when the intro
 * should open on this visit, which covers the page until the island takes over. The island opens the
 * intro on load only when it finds that mark, so on load this script is the one place that decides. A storage
 * error counts as seen. The mark clears itself if the island never loads.
 */
export const introGateScript = `(() => {
  let seen = true;
  try { seen = localStorage.getItem(${JSON.stringify(INTRO_SEEN_KEY)}) === '1'; } catch {}
  if (seen || !(${introFitsSource})) return;
  const root = document.documentElement;
  root.dataset.intro = 'pending';
  setTimeout(() => { if (root.dataset.intro === 'pending') delete root.dataset.intro; }, 4000);
})();`;
