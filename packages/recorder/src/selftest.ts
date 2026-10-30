import { randomUUID } from 'node:crypto';
import {
  bestPageOffset,
  nodeNow,
  pageNowExpression,
  type CaptureCoverage,
} from '@pingwright/core';
import type { BrowserContext } from 'playwright';
import type { CollectorHandler } from './collector.ts';
import { COLLECTOR_ORIGIN, SELFTEST_ORIGIN } from './origins.ts';

const RESEND_MS = 200;

// Each source resends until the page is closed; the collector handler dedupes by source.
const repeat = (send: string) => `${send} setInterval(() => { ${send} }, ${RESEND_MS});`;
const beacon = (source: string) =>
  `navigator.sendBeacon('${COLLECTOR_ORIGIN}/report', JSON.stringify({ source: '${source}' }));`;

/** The prefix is random per launch, so a site cannot send a report that the recorder takes for its own. */
function selfTestPage(sources: Record<'page' | 'iframe' | 'dedicatedWorker', string>): string {
  // The iframe waits for its load event: requests sent while a sandboxed srcdoc iframe loads bypass context.route.
  const iframeScript = `addEventListener('load', () => setTimeout(() => { ${repeat(beacon(sources.iframe))} }, 100));`;
  // sendBeacon does not exist in workers.
  const workerScript = `const send = () => fetch('${COLLECTOR_ORIGIN}/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ source: '${sources.dedicatedWorker}' }) }); send(); setInterval(send, ${RESEND_MS});`;
  return `<!doctype html><meta charset="utf-8"><title>Pingwright self-test</title>
<script>
${repeat(beacon(sources.page))}
new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerScript)}], { type: 'text/javascript' })));
</script>
<iframe sandbox="allow-scripts" srcdoc="${`<script>${iframeScript}</script>`.replaceAll('"', '&quot;')}"></iframe>`;
}

export interface SelfTestResult {
  coverage: CaptureCoverage;
  /** Added to a page clock reading to get the shared clock. */
  clockOffset: number;
  /** Reports whose source starts with this belong to the self-test, whenever they arrive. */
  sourcePrefix: string;
}

/**
 * Loads a routed page that sends one beacon from the page, from a sandboxed iframe and from a dedicated
 * worker, and reports which of them reached the collector. The page is closed before the run starts.
 */
export async function runSelfTest(
  context: BrowserContext,
  setCollectorHandler: (handler: CollectorHandler) => void,
  timeoutMs = 10_000,
): Promise<SelfTestResult> {
  const sourcePrefix = `selftest:${randomUUID()}:`;
  const SOURCES = { page: `${sourcePrefix}page`, iframe: `${sourcePrefix}iframe`, dedicatedWorker: `${sourcePrefix}worker` };
  const seen = new Set<string>();
  let done: () => void = () => undefined;
  const allSeen = new Promise<void>((resolve) => (done = resolve));
  setCollectorHandler((parsed) => {
    if (parsed.ok) seen.add(parsed.source);
    if (Object.values(SOURCES).every((s) => seen.has(s))) done();
  });
  const route = (url: URL) => url.origin === SELFTEST_ORIGIN;
  await context.route(route, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: selfTestPage(SOURCES) }));
  const page = await context.newPage();
  try {
    await page.goto(`${SELFTEST_ORIGIN}/`);
    const timer = setTimeout(done, timeoutMs);
    await allSeen;
    clearTimeout(timer);
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const before = nodeNow();
      const pageTime = await page.evaluate<number>(pageNowExpression);
      samples.push({ before, page: pageTime, after: nodeNow() });
    }
    return {
      coverage: {
        page: seen.has(SOURCES.page),
        iframe: seen.has(SOURCES.iframe),
        dedicatedWorker: seen.has(SOURCES.dedicatedWorker),
        serviceWorker: 'chromium-only',
      },
      clockOffset: bestPageOffset(samples),
      sourcePrefix,
    };
  } finally {
    await page.close();
    await context.unroute(route);
  }
}
