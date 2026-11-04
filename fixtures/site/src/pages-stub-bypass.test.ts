import { afterAll, beforeAll, expect, test } from 'vitest';
import { startFixtureSite, type FixtureSite } from './index.ts';

let site: FixtureSite;

beforeAll(async () => {
  site = await startFixtureSite();
});

afterAll(async () => {
  await site.close();
});

test('/stub-bypass loads a child frame from the hop route with the page query', async () => {
  const html = await (await fetch(`${site.url}/stub-bypass`)).text();
  expect(html).toContain("'/stub-bypass/hop' + location.search");
});

test('/stub-bypass/hop redirects to the collection path with the query', async () => {
  const res = await fetch(`${site.url}/stub-bypass/hop?email=a%40example.test&sid=x`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location')!, site.url);
  expect(location.pathname).toBe('/g/collect');
  expect(location.searchParams.get('tid')).toBe('G-PWTEST0001');
  expect(location.searchParams.get('email')).toBe('a@example.test');
  expect(location.searchParams.get('sid')).toBe('x');
});
