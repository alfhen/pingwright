import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { containerId, fakeWorkspace, fixtureTags, resolveContainer } from './containers.ts';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/container/tags serves its file, which loads the container, reports, and adds a sandboxed copy of itself', async () => {
  const html = await (await fetch(`${site.url}/container/tags`)).text();
  expect(html).toBe(readFileSync(new URL('../public/container-tags.html', import.meta.url), 'utf8'));
  expect(html).toContain('https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1');
  expect(html).toContain('pwContainer.reportTags()');
  expect(html).toContain("setAttribute('sandbox', 'allow-scripts')");
  expect(html).toContain("frame.src = '/container/tags'");
});

test('the third party host logs a posted body and answers other requests with the image', async () => {
  const posted = await fetch(`${site.thirdPartyUrl}/tag-report-log`, { method: 'POST', body: '{"x":1}' });
  expect(posted.status).toBe(204);
  expect(site.tagReportLog).toContain('{"x":1}');
  expect((await fetch(`${site.thirdPartyUrl}/other.gif`)).headers.get('content-type')).toBe('image/gif');
});

interface Page {
  reports: unknown[];
  logged: string[];
  run(code: string): void;
}

function pageWithContainer(build: 'published' | 'workspace', withBinding: boolean): Page {
  const params = new URLSearchParams({ id: containerId, ...(build === 'workspace' ? fakeWorkspace : {}) });
  const result = resolveContainer(params, 'http://127.0.0.1:1', 'http://127.0.0.1:1/tag-report-log');
  if (result.status !== 200) throw new Error('no container');
  const reports: unknown[] = [];
  const logged: string[] = [];
  const sandbox: Record<string, unknown> = {
    fetch: (_url: string, init: { body: string }) => {
      logged.push(init.body);
      return Promise.resolve();
    },
    setTimeout,
    JSON,
    Array,
    Date,
    ...(withBinding ? { tagreeveTagReport: (payload: unknown) => (reports.push(payload), Promise.resolve()) } : {}),
  };
  sandbox.window = sandbox;
  runInNewContext(result.body, sandbox);
  return { reports, logged, run: (code) => void runInNewContext(code, sandbox) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe('the container shim running the shipped template', () => {
  test.each(['published', 'workspace'] as const)('the %s build reports every event with its tag list', async (build) => {
    const page = pageWithContainer(build, true);
    expect(page.reports).toEqual([]);
    page.run('pwContainer.reportTags()');
    await settle();
    expect(page.reports).toHaveLength(2);
    const [first, second] = page.reports as { container: string; event: string; gtmUniqueEventId: number; version: string; tags: { id: string; name: string | null }[] }[];
    expect([first!.event, second!.event]).toEqual(['gtm.js', 'container_event']);
    expect(first!.container).toBe(containerId);
    expect(first!.gtmUniqueEventId).not.toBe(second!.gtmUniqueEventId);
    expect(first!.version).toBe(build === 'published' ? '3' : 'QUICK_PREVIEW');
    expect(first!.tags.map((t) => t.id)).toEqual(fixtureTags[build].map((t) => String(t.id)));
    expect(first!.tags.find((t) => t.id === (build === 'published' ? '12' : '13'))!.name).toBeNull();
    expect(page.logged).toHaveLength(2);
    expect(JSON.parse(page.logged[0]!)).toEqual(JSON.parse(JSON.stringify(first)));
  });

  test('without the binding callInWindow returns undefined, nothing is reported, and the shim still logs the call', async () => {
    const page = pageWithContainer('published', false);
    page.run('pwContainer.reportTags(["gtm.js"])');
    await settle();
    expect(page.reports).toEqual([]);
    expect(page.logged).toHaveLength(1);
  });

  test('the tag lists are the ones the plan names', () => {
    expect(fixtureTags.published.map((t) => t.id)).toEqual([11, 12]);
    expect(fixtureTags.workspace.map((t) => t.id)).toEqual([11, 13, 14, 77, 88, 89]);
    for (const build of ['published', 'workspace'] as const) expect(fixtureTags[build].map((t) => t.id)).not.toContain(45);
  });

  test('only the workspace build carries the fake auth, in the name of tag 89', () => {
    expect(JSON.stringify(fixtureTags.published)).not.toContain(fakeWorkspace.gtm_auth);
    expect(fixtureTags.workspace.find((t) => t.id === 89)!.name).toContain(fakeWorkspace.gtm_auth);
    expect(fixtureTags.workspace.find((t) => t.id === 88)!.name).toContain('pw-fixture@example.com');
  });
});
