import { expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { outDir, run, runCli } from './cli-helpers.ts';

async function renderReport(runPath: string, name: string): Promise<string> {
  const out = join(outDir, name);
  expect((await runCli(['report', runPath, '--html', out])).code).toBe(0);
  return readFile(out, 'utf8');
}

async function cookieRule(name: string) {
  const r = await run(name);
  const summary = JSON.parse(r.stdout) as { path: string; results: { expectation: string; pass: boolean; message: string }[] };
  const result = summary.results.find((x) => x.expectation.includes('cookie'))!;
  const note = r.records!.results.find((x) => x.expectation === result.expectation)?.note;
  const html = await renderReport(summary.path, `${name}.html`);
  return { code: r.code, result, note, requests: r.records!.requests, text: r.stdout + r.stderr + JSON.stringify(r.records!.results), html };
}

test('a cookie the browser rejects is reported as not stored, and the rule still fails', async () => {
  const { code, result, note, requests, text, html } = await cookieRule('cookie-unstored');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('found _pwunstored from Set-Cookie (1 request); no later checkpoint has it');
  expect(note).toBe('cookieNotStored');
  expect(requests.some((q) => q.url.includes('pw-fixture-cookie-value'))).toBe(true);
  expect(text).not.toContain('pw-fixture-cookie-value');
  expect(html).not.toContain('pw-fixture-cookie-value');
}, 90_000);

test('a cookie the browser keeps is reported as stored', async () => {
  const { code, result, note } = await cookieRule('cookie-stored');
  expect(code).toBe(1);
  expect(result.pass).toBe(false);
  expect(result.message).toContain('from Set-Cookie (1 request); stored by the browser');
  expect(note).toBeUndefined();
}, 90_000);
