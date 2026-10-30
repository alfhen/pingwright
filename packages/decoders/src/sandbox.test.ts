import { expect, test } from 'vitest';
import { stripSandboxPrefix } from './sandbox.ts';

test.each([
  ['/web-pixels@abc123/custom/web-pixel-1@1/sandbox/modern/collections/yarn', '/collections/yarn'],
  ['/web-pixels@0.0.0-fixture/sandbox/modern/', '/'],
  ['/web-pixels@abc123/sandbox/modern', '/'],
  ['/web-pixels@abc123/sandbox/legacy/products/tee', '/products/tee'],
  ['/web-pixels@e1f2/strict/web-pixel-9@2/sandbox/lax/cart', '/cart'],
  ['/wpm@0000000000000000/custom/web-pixel-3@1/sandbox/modern/checkout', '/checkout'],
  ['/en/web-pixels@abc/sandbox/modern/cart', '/en/cart'],
  ['/collections/yarn', '/collections/yarn'],
  ['/products/sandbox/x', '/products/sandbox/x'],
  ['/', '/'],
])('stripSandboxPrefix(%s)', (input, expected) => {
  expect(stripSandboxPrefix(input)).toBe(expected);
});
