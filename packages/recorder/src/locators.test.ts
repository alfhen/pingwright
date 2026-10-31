import { describe, expect, test } from 'vitest';
import { chromium } from 'playwright';
import { controlsFromSnapshot, resolveLocator, timeoutMessage, visibleName } from './locators.ts';

test('reads real ariaSnapshot output for names that Playwright quotes', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<button>Size: M</button><button>Item #3</button><button>Men's {XL}</button><button>White (01)</button>`,
    );
    expect(controlsFromSnapshot(await page.locator('body').ariaSnapshot())).toEqual([
      'button "Size: M"',
      'button "Item #3"',
      `button "Men's {XL}"`,
      'button "White (01)"',
    ]);
  } finally {
    await browser.close();
  }
});

describe('visibleName', () => {
  test('hides an email, a 6+ digit run and a hash-shaped name', () => {
    expect(visibleName('Sign in as user@example.com')).toBe('(hidden)');
    expect(visibleName('Call +46 70 123 45 67')).toBe('(hidden)');
    expect(visibleName('Order 1234567')).toBe('(hidden)');
    expect(visibleName('a'.repeat(32))).toBe('(hidden)');
    expect(visibleName('Qk3Zx9Lm0Pq7Rt5Vw2Yb8Nc4Dd')).toBe('(hidden)');
  });

  test('keeps ordinary names and cuts them at 60 characters', () => {
    expect(visibleName('White (01)')).toBe('White (01)');
    expect(visibleName('Size 10 pack')).toBe('Size 10 pack');
    expect(visibleName('x '.repeat(40))).toHaveLength(63);
    expect(visibleName('x '.repeat(40)).endsWith('...')).toBe(true);
  });
});

describe('controlsFromSnapshot', () => {
  const snapshot = [
    '- heading "Tiles" [level=1]',
    '- button "White (01)"',
    '- radio "Black (02)" [checked]',
    '- textbox "Email": typed@example.com',
    '- text: White paragraph',
    '- link "Home":',
    '  - /url: /',
    '- checkbox "Gift \\"wrap\\""',
    '- tab "Details"',
    '- option "Germany"',
    '- combobox "Country"',
    '- button "x@example.com"',
  ].join('\n');

  test('lists only the six control families, with role and name', () => {
    expect(controlsFromSnapshot(snapshot)).toEqual([
      'button "White (01)"',
      'radio "Black (02)"',
      'link "Home"',
      'checkbox "Gift "wrap""',
      'tab "Details"',
      'option "Germany"',
      'button "(hidden)"',
    ]);
  });

  test('reads single-quoted snapshot keys', () => {
    const quoted = [`- 'button "Size: M"'`, `- 'button "Item #3"'`, `- 'button "Men''s {XL}"'`, '- button "White (01)"'].join('\n');
    expect(controlsFromSnapshot(quoted)).toEqual([
      'button "Size: M"',
      'button "Item #3"',
      `button "Men's {XL}"`,
      'button "White (01)"',
    ]);
  });

  test('lists at most ten', () => {
    const many = Array.from({ length: 15 }, (_, i) => `- button "B${i}"`).join('\n');
    expect(controlsFromSnapshot(many)).toHaveLength(10);
  });
});

test('a timeout message adds the list, and falls back to the first line when the snapshot fails', async () => {
  const page = (snapshot: () => Promise<string>) => ({ locator: () => ({ ariaSnapshot: snapshot }) }) as never;
  expect(await timeoutMessage(page(() => Promise.resolve('- radio "White (01)"')), 'Timeout.')).toBe(
    'Timeout. Controls on the page: radio "White (01)".',
  );
  expect(await timeoutMessage(page(() => Promise.resolve('- heading "x"')), 'Timeout.')).toBe('Timeout.');
  expect(await timeoutMessage(page(() => Promise.reject(new Error('closed'))), 'Timeout.')).toBe('Timeout.');
});

describe('resolveLocator', () => {
  const fake = (present: Set<string>) => {
    const calls: unknown[][] = [];
    const page = {
      locator: (selector: string) => ({ count: () => Promise.resolve(present.has(selector) ? 1 : 0), first: () => ({ selector }) }),
      getByRole: (...args: unknown[]) => {
        calls.push(args);
        return { first: () => ({ role: args }) };
      },
    };
    return { page: page as never, calls };
  };

  test('role and name map to getByRole, with exact only when given', async () => {
    const { page, calls } = fake(new Set());
    await resolveLocator(page, { role: 'radio', name: 'White (01)' }, 100);
    await resolveLocator(page, { role: 'radio', name: 'White (01)', exact: true }, 100);
    await resolveLocator(page, { role: 'button' }, 100);
    expect(calls).toEqual([['radio', { name: 'White (01)' }], ['radio', { name: 'White (01)', exact: true }], ['button', {}]]);
  });

  test('any uses the first selector that matches, and reports its index', async () => {
    const { page } = fake(new Set(['b', 'c']));
    expect(await resolveLocator(page, { any: ['a', 'b', 'c'] }, 100)).toMatchObject({ index: 1, locator: { selector: 'b' } });
  });

  test('any waits for a later selector and times out when none match', async () => {
    const present = new Set<string>();
    const { page } = fake(present);
    setTimeout(() => present.add('late'), 150);
    expect(await resolveLocator(page, { any: ['a', 'late'] }, 2000)).toMatchObject({ index: 1 });
    await expect(resolveLocator(page, { any: ['a', 'b'] }, 200)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
