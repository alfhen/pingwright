import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { inject } from 'vitest';
import { chromeUserAgent } from '../packages/recorder/src/user-agent.ts';

export { astro, astroEnv, buildDocs, dist, root } from './docs-build.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    docsUrl: string;
  }
}

/** Where the docs global setup serves this run's build. */
export const docsUrl = inject('docsUrl');

/**
 * A browser context for the docs tests. The first-visit intro covers `/` in a fresh context, so every docs
 * test except the intro's own marks the intro as seen before any page script runs.
 */
export async function newDocsContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: chromeUserAgent(browser.version()), ...options });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('tagreeve.introSeen', '1');
    } catch {
      // Pages without storage, such as about:blank, do not show the intro either.
    }
  });
  return context;
}
