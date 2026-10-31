import type { Locator as ScenarioLocator } from '@pingwright/expect';
import type { Locator, Page } from 'playwright';

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
