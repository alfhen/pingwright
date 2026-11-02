import { globToRegExp } from '@pingwright/core';
import type { Condition, Locator, UrlMatcher } from '@pingwright/expect';
import type { BrowserContext, Page } from 'playwright';

const POLL_MS = 100;

/** A glob is matched against the path and query, a regular expression against the whole URL. */
export function urlMatches(matcher: UrlMatcher, href: string): boolean {
  if ('matches' in matcher) return new RegExp(matcher.matches).test(href);
  try {
    const url = new URL(href);
    return globToRegExp(matcher.glob).test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

type PlaywrightRole = Parameters<Page['getByRole']>[0];

/** True when the element is attached and visible. Reads no text and no value. */
async function locatorShown(page: Page, locator: Locator): Promise<boolean> {
  const shown = (selector: string) => page.locator(selector).first().isVisible();
  if (typeof locator === 'string') return shown(locator);
  if ('any' in locator) {
    for (const selector of locator.any) if (await shown(selector)) return true;
    return false;
  }
  const options = locator.name === undefined ? {} : { name: locator.name, ...(locator.exact === undefined ? {} : { exact: locator.exact }) };
  return page.getByRole(locator.role as PlaywrightRole, options).first().isVisible();
}

/** Checks the top-level document of every page in the context. */
export async function conditionHolds(context: BrowserContext, condition: Condition): Promise<boolean> {
  for (const page of context.pages()) {
    try {
      if ('url' in condition ? urlMatches(condition.url, page.url()) : await locatorShown(page, condition.locator)) return true;
    } catch {}
  }
  return false;
}

/** Resolves once the condition holds. It stays pending when the signal aborts first. */
export async function watchCondition(context: BrowserContext, condition: Condition, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (await conditionHolds(context, condition)) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  await new Promise<void>(() => {});
}

/** The condition as written in the scenario. */
export function describeCondition(condition: Condition): string {
  if ('url' in condition) return 'glob' in condition.url ? condition.url.glob : `matches ${condition.url.matches}`;
  const l = condition.locator;
  if (typeof l === 'string') return l;
  if ('any' in l) return `any of ${l.any.join(', ')}`;
  return l.name === undefined ? l.role : `${l.role} "${l.name}"`;
}

export function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
