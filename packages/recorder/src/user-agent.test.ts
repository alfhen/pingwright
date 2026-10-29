import { expect, test } from 'vitest';
import { chromeUserAgent } from './user-agent.ts';

test('builds a Chrome user agent from the browser version', () => {
  const ua = chromeUserAgent('156.0.8078.4');
  expect(ua).toContain('Chrome/156.0.0.0');
  expect(ua).not.toContain('Headless');
});
