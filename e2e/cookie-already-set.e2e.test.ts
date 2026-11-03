import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outDir, run, runCli, site } from './cli-helpers.ts';

async function renderReport(runPath: string, name: string): Promise<string> {
  const out = join(outDir, name);
  expect((await runCli(['report', runPath, '--html', out])).code).toBe(0);
  return readFile(out, 'utf8');
}

test('a cookie that was already set is not reported as stored, and the rule still fails', async () => {
  const r = await run('cookie-already-set');
  const summary = JSON.parse(r.stdout) as { path: string; results: { expectation: string; pass: boolean; message: string }[] };
  const result = summary.results.find((x) => x.expectation.includes('cookie'))!;
  const records = r.records!;
  const note = records.results.find((x) => x.expectation === result.expectation)?.note;

  expect(r.code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('found _pwalready from Set-Cookie (1 request); the cookie was already set before this response');
  expect(result.message).not.toContain('stored by the browser');
  expect(note).toBeUndefined();

  const early = records.checkpoints.find((c) => c.label === 'early')!;
  expect(early.cookies.map((c) => c.name)).toContain('_pwalready');

  const setter = records.requests.find((q) => q.url.endsWith('/session/already'))!;
  expect(records.responses.find((x) => x.requestId === setter.id)!.setCookieNames).toEqual(['_pwalready']);
  expect((await fetch(`${site.url}/session/already`)).headers.get('set-cookie')).toContain('pw-fixture-cookie-value');
  expect(r.stdout + r.stderr + JSON.stringify(records.results)).not.toContain('pw-fixture-cookie-value');
  expect(await renderReport(summary.path, 'cookie-already-set.html')).not.toContain('pw-fixture-cookie-value');
}, 90_000);
