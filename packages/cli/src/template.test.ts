import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { main } from './main.ts';

const file = readFileSync(new URL('../../recorder/src/gtm-templates/web-tag-reporter.tpl', import.meta.url), 'utf8');

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  return { code, out, err };
}

test('template web prints the file byte for byte', async () => {
  const { code, out, err } = await run(['template', 'web']);
  expect(code).toBe(0);
  expect(out).toBe(file);
  expect(err).toBe('');
});

test('template web --json holds the template and the setup', async () => {
  const { code, out } = await run(['template', 'web', '--json']);
  expect(code).toBe(0);
  const json = JSON.parse(out) as Record<string, unknown> & { steps: string[] };
  expect(Object.keys(json).sort()).toEqual(['fileName', 'name', 'setup', 'steps', 'template', 'templateVersion']);
  expect(json.templateVersion).toBe(1);
  expect(json.name).toBe('web');
  expect(json.fileName).toBe('tagreeve-tag-reporter.tpl');
  expect(json.template).toBe(file);
  expect(json.setup).toEqual({
    trigger: { type: 'customEvent', eventName: '.*', regex: true },
    consent: 'noAdditionalConsentRequired',
    tagMetadata: { includeTagName: true, key: 'name' },
    publish: false,
  });
  expect(json.steps.length).toBeGreaterThan(3);
  const last = json.steps.at(-1)!;
  expect(last).toContain('tags[<container>].reports');
  expect(last).toContain('greater than 0');
  expect(last).not.toMatch(/not empty/i);
  expect(json.steps.some((step) => /never publish/i.test(step))).toBe(true);
});

test.each([[['template']], [['template', 'server']], [['template', 'web', '--html', 'x']], [['template', 'web', 'extra']]])('%j exits 2', async (argv) => {
  const { code, out, err } = await run(argv);
  expect(code).toBe(2);
  expect(out).toBe('');
  expect(err).toContain('--help');
});

test('template web --json tells the agent that the override file is a secret', async () => {
  const { out } = await run(['template', 'web', '--json']);
  const json = JSON.parse(out) as { steps: string[] };
  expect(json.steps.some((step) => /gtmAuth/.test(step) && /secret/.test(step) && /transcript/.test(step))).toBe(true);
});

test('template web --json holds no GTM ID, auth value or record ID outside the template', async () => {
  const { out } = await run(['template', 'web', '--json']);
  const { template, ...rest } = JSON.parse(out) as Record<string, unknown>;
  const text = JSON.stringify(rest);
  expect(template).toBe(file);
  expect(text).not.toMatch(/GTM-/);
  expect(text).not.toMatch(/gtm_auth=|gtmAuth["']?\s*:/);
  expect(text).not.toMatch(/\b(run|rec|tag|hit|step)_[0-9a-z]+/);
  expect([...file.matchAll(/GTM-[A-Z0-9]+/g)].every((m) => m[0] === 'GTM-PWTEST1')).toBe(true);
});

test('template with an unknown name does not echo it', async () => {
  const { code, err } = await run(['template', 'FAKE-NAME']);
  expect(code).toBe(2);
  expect(err).toContain('web is the only name');
  expect(err).not.toContain('FAKE-NAME');
});
