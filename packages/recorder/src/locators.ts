import type { Locator as ScenarioLocator } from '@tagreeve/expect';
import type { BrowserContext, Locator, Page } from 'playwright';

const ROLE_FAMILIES = ['button', 'radio', 'checkbox', 'link', 'tab', 'option'];
const MAX_LISTED = 10;
const MAX_NAME = 60;
const POLL_MS = 100;

type PlaywrightRole = Parameters<Page['getByRole']>[0];

export interface Resolved {
  locator: Locator;
  /** The position in an `any` list that matched. */
  index?: number;
}

/** The first match of the locator. An `any` list uses the first selector that matches an element within `timeout`. */
export async function resolveLocator(page: Page, locator: ScenarioLocator, timeout: number): Promise<Resolved> {
  if (typeof locator === 'string') return { locator: page.locator(locator).first() };
  if (!('any' in locator)) {
    const options = locator.name === undefined ? {} : { name: locator.name, ...(locator.exact === undefined ? {} : { exact: locator.exact }) };
    return { locator: page.getByRole(locator.role as PlaywrightRole, options).first() };
  }
  const deadline = Date.now() + timeout;
  for (;;) {
    for (const [index, selector] of locator.any.entries()) {
      if ((await page.locator(selector).count()) > 0) return { locator: page.locator(selector).first(), index };
    }
    if (Date.now() >= deadline) {
      const error = new Error(`no selector of the list matched within ${timeout} ms.`);
      error.name = 'TimeoutError';
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const EMAIL_LIKE = /@/;
const DIGIT_RUN = /\d(?:[\s().+-]?\d){5,}/;
const HEX_TOKEN = /[0-9a-fA-F]{32,}/;
const DIGEST_TOKEN = /(?=\S*[A-Z])(?=\S*[a-z])(?=\S*\d)[A-Za-z0-9_+/-]{22,}={0,2}/;

/** A name that is an email, a phone or id number, or a hash is never printed. */
export function visibleName(name: string): string {
  if (EMAIL_LIKE.test(name) || DIGIT_RUN.test(name) || HEX_TOKEN.test(name) || DIGEST_TOKEN.test(name)) return '(hidden)';
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME)}...` : name;
}

const SNAPSHOT_KEY = /^\s*- (?:'((?:[^']|'')*)'|(.*))/;
const CONTROL_KEY = new RegExp(`^(${ROLE_FAMILIES.join('|')}) "((?:[^"\\\\]|\\\\.)*)"`);

interface Control {
  role: string;
  name: string;
}

function parseControls(snapshot: string): Control[] {
  const found: Control[] = [];
  for (const line of snapshot.split('\n')) {
    const k = SNAPSHOT_KEY.exec(line);
    if (!k) continue;
    const m = CONTROL_KEY.exec(k[1] === undefined ? k[2]! : k[1].replaceAll("''", "'"));
    if (!m) continue;
    try {
      found.push({ role: m[1]!, name: JSON.parse(`"${m[2]!}"`) as string });
    } catch {
      continue;
    }
  }
  return found;
}

/** Role and accessible name of up to ten controls in the accessibility tree. Never text content or form values. */
export function controlsFromSnapshot(snapshot: string): string[] {
  return parseControls(snapshot)
    .slice(0, MAX_LISTED)
    .map((c) => `${c.role} "${visibleName(c.name)}"`);
}

const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

function sharedWords(a: string, b: string): number {
  const bag = new Set(words(b));
  return [...new Set(words(a))].filter((w) => bag.has(w)).length;
}

function sharedPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

/** The controls of a role, closest name first: shared words, then shared prefix, then edit distance. Ties keep page order. */
function rankByName(controls: Control[], wanted: string): Control[] {
  const target = wanted.toLowerCase();
  return controls
    .map((control, index) => {
      const name = control.name.toLowerCase();
      return { control, index, words: sharedWords(name, target), prefix: sharedPrefix(name, target), distance: editDistance(name, target) };
    })
    .sort((x, y) => y.words - x.words || y.prefix - x.prefix || x.distance - y.distance || x.index - y.index)
    .map((r) => r.control);
}

export interface RequestedControl {
  role: string;
  name?: string;
}

/** A timeout message that also lists the controls on the page, those of the requested role first when there is one. */
export async function timeoutMessage(page: Page, firstLine: string, requested?: RequestedControl): Promise<string> {
  try {
    const snapshot = await page.locator('body').ariaSnapshot({ timeout: 5000 });
    const general = controlsFromSnapshot(snapshot);
    const generalLine = general.length === 0 ? firstLine : `${firstLine} Controls on the page: ${general.join(', ')}.`;
    if (!requested || !ROLE_FAMILIES.includes(requested.role)) return generalLine;
    const ofRole = parseControls(snapshot).filter((c) => c.role === requested.role);
    if (ofRole.length === 0) return `${firstLine} No ${requested.role} controls on the page.${general.length === 0 ? '' : ` Controls on the page: ${general.join(', ')}.`}`;
    const ranked = requested.name === undefined ? ofRole : rankByName(ofRole, requested.name);
    return `${firstLine} Closest ${requested.role} controls: ${ranked.slice(0, MAX_LISTED).map((c) => `"${visibleName(c.name)}"`).join(', ')}.`;
  } catch {
    return firstLine;
  }
}

const BLOCK_REASONS = ['required, not ticked', 'invalid', 'aria-invalid'] as const;
type BlockReason = (typeof BLOCK_REASONS)[number];

const INPUT_TYPES = ['checkbox', 'color', 'date', 'datetime-local', 'email', 'file', 'month', 'number', 'password', 'radio', 'range', 'search', 'tel', 'text', 'time', 'url', 'week'];
const WIDGET_ROLES = ['checkbox', 'combobox', 'listbox', 'radio', 'radiogroup', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox'];
const KINDS: readonly string[] = [...INPUT_TYPES, ...WIDGET_ROLES, 'select', 'textarea'];

interface BlockingControl {
  kind: string;
  name: string;
  reason: BlockReason;
}

/** Runs in the page. Reads `validity` and attributes only, never a value, and never calls `checkValidity()` or `reportValidity()`. Clones nothing, so no page code runs and no image loads. */
function readBlockingControls(max: number): BlockingControl[] {
  const found: BlockingControl[] = [];
  const validationText =
    'input, select, textarea, option, script, style, output, [role="alert"], [role="status"], [aria-live], [aria-invalid="true"], [aria-errormessage], .error, .invalid, .error-message, .invalid-feedback, .field-error, .text-danger, .field__message--error';
  const messageIds = new Set<string>();
  const describedIds = new Set<string>();
  for (const holder of document.querySelectorAll('[aria-errormessage], [aria-describedby]')) {
    for (const id of (holder.getAttribute('aria-errormessage') ?? '').split(/\s+/)) if (id) messageIds.add(id);
    for (const id of (holder.getAttribute('aria-describedby') ?? '').split(/\s+/)) if (id) describedIds.add(id);
  }
  const isMessage = (n: Element) => n.matches(validationText) || messageIds.has(n.id) || describedIds.has(n.id);
  const cleanText = (source: Element, control: Element): string => {
    if (!source.contains(control) && (messageIds.has(source.id) || source.matches(validationText))) return '';
    const walker = document.createTreeWalker(source, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && isMessage(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let text = '';
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeType === Node.TEXT_NODE) text += `${n.nodeValue ?? ''} `;
    return text;
  };
  const joinSources = (sources: Element[], el: Element): string => {
    const own = new Set(`${el.getAttribute('aria-describedby') ?? ''} ${el.getAttribute('aria-errormessage') ?? ''}`.split(/\s+/));
    const texts = sources.map((source) => ({ own: source.id !== '' && own.has(source.id), text: cleanText(source, el) }));
    const kept = texts.filter((t) => !t.own);
    return (kept.some((t) => t.text.trim()) ? kept : texts).map((t) => t.text).join(' ').replace(/\s+/g, ' ').trim();
  };
  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) return aria;
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const text = joinSources(
        ids.split(/\s+/).flatMap((id) => document.getElementById(id) ?? []),
        el,
      );
      if (text) return text;
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const text = joinSources([...labels], el);
      if (text) return text;
    }
    return el.getAttribute('name') ?? '';
  };
  for (const el of document.querySelectorAll('input, select, textarea, [aria-invalid="true"]')) {
    if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'reset' || el.type === 'image')) continue;
    const input = el as HTMLInputElement;
    const checkbox = el instanceof HTMLInputElement && el.type === 'checkbox';
    let reason: BlockReason | undefined;
    if (checkbox && !input.checked && input.willValidate && (input.required || el.getAttribute('aria-required') === 'true')) reason = 'required, not ticked';
    else if ('validity' in el && input.willValidate && input.validity.valid === false) reason = 'invalid';
    else if (el.getAttribute('aria-invalid') === 'true') reason = 'aria-invalid';
    if (!reason) continue;
    const kind = el instanceof HTMLInputElement ? el.type : (el.getAttribute('role') ?? el.tagName.toLowerCase());
    found.push({ kind, name: nameOf(el), reason });
    if (found.length >= max) break;
  }
  return found;
}

const DIAGNOSTIC_DEADLINE_MS = 3000;

/** Playwright's `evaluate` has no timeout, and a page that stopped responding would hold the original timeout error back. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('diagnostic timed out')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Controls on the top-level document of each open page that block a form from submitting: kind, name and reason. Never a value, a placeholder or an error text, and never a frame. */
export async function blockingControls(context: BrowserContext): Promise<string[]> {
  const listed: string[] = [];
  for (const page of context.pages()) {
    try {
      const controls = await withDeadline(page.evaluate(readBlockingControls, MAX_LISTED), DIAGNOSTIC_DEADLINE_MS);
      for (const c of controls) {
        if (!BLOCK_REASONS.includes(c.reason)) continue;
        const kind = KINDS.includes(c.kind) ? c.kind : 'control';
        const name = visibleName(String(c.name));
        listed.push(`${kind}${name ? ` "${name}"` : ''} (${c.reason})`);
      }
    } catch {}
    if (listed.length >= MAX_LISTED) break;
  }
  return listed.slice(0, MAX_LISTED);
}
