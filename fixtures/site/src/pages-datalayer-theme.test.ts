import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

interface Page {
  pwOwnPushes: number;
  dataLayer: ArrayLike<unknown>[] & { push: unknown };
  pwRaw: unknown;
}

async function run(query: string): Promise<Page> {
  const html = await (await fetch(`${site.url}/datalayer-theme${query}`)).text();
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!;
  const sandbox: Record<string, unknown> = { URLSearchParams, location: { search: query }, setTimeout: (fn: () => void) => fn() };
  sandbox.window = sandbox;
  runInNewContext(script, sandbox);
  return sandbox as unknown as Page;
}

test('plain pushes n items and counts them', async () => {
  const page = await run('?mode=plain');
  expect(page.pwOwnPushes).toBe(3);
  expect(page.dataLayer).toHaveLength(3);
  expect(page.pwRaw).toBe(page.dataLayer);
  expect((await run('?mode=plain&n=10')).dataLayer).toHaveLength(10);
});

test('theme makes 8 pushes, a consent default first, with its own push', async () => {
  const page = await run('?mode=theme');
  expect(page.pwOwnPushes).toBe(8);
  expect(page.dataLayer).toHaveLength(8);
  expect(Array.from(page.dataLayer[0]!).slice(0, 2)).toEqual(['consent', 'default']);
  expect(Object.prototype.hasOwnProperty.call(page.dataLayer, 'push')).toBe(true);
});

test('redefine replaces the property and makes 3 pushes', async () => {
  const page = await run('?mode=redefine');
  expect(page.pwOwnPushes).toBe(3);
  expect(page.dataLayer).toHaveLength(3);
});

test('unshift records one push and adds n items in front', async () => {
  const page = await run('?mode=unshift&n=3');
  expect(page.pwOwnPushes).toBe(4);
  expect(page.dataLayer).toHaveLength(4);
  expect((page.dataLayer[3] as unknown as { event: string }).event).toBe('pw_item_0');
});

test('every push carries the planted value and URL', async () => {
  for (const mode of ['plain', 'theme', 'redefine', 'unshift']) {
    const text = JSON.stringify((await run(`?mode=${mode}`)).dataLayer);
    expect(text).toContain('pw-planted-value-1');
    expect(text).toContain('https://planted.example.test/x');
  }
});
