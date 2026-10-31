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

/** Role and accessible name of up to ten controls in the accessibility tree. Never text content or form values. */
export function controlsFromSnapshot(snapshot: string): string[] {
  const listed: string[] = [];
  for (const line of snapshot.split('\n')) {
    const k = SNAPSHOT_KEY.exec(line);
    if (!k) continue;
    const m = CONTROL_KEY.exec(k[1] === undefined ? k[2]! : k[1].replaceAll("''", "'"));
    if (!m) continue;
    let name: string;
    try {
      name = JSON.parse(`"${m[2]!}"`) as string;
    } catch {
      continue;
    }
    listed.push(`${m[1]!} "${visibleName(name)}"`);
    if (listed.length === MAX_LISTED) break;
  }
  return listed;
}

/** A timeout message that also lists the controls on the page. */
export async function timeoutMessage(page: Page, firstLine: string): Promise<string> {
  try {
    const controls = controlsFromSnapshot(await page.locator('body').ariaSnapshot({ timeout: 5000 }));
    return controls.length === 0 ? firstLine : `${firstLine} Controls on the page: ${controls.join(', ')}.`;
  } catch {
    return firstLine;
  }
}
