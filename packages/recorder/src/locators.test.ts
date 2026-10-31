import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { controlsFromSnapshot, resolveLocator, timeoutMessage, visibleName } from './locators.ts';

describe('visibleName', () => {
  test('hides an email, a 6+ digit run and a hash-shaped name', () => {
    expect(visibleName('Sign in as user@example.com')).toBe('(hidden)');
    expect(visibleName('Call +46 70 123 45 67')).toBe('(hidden)');
    expect(visibleName('Order 1234567')).toBe('(hidden)');
    expect(visibleName('a'.repeat(32))).toBe('(hidden)');
    expect(visibleName('Qk3Zx9Lm0Pq7Rt5Vw2Yb8Nc4Dd')).toBe('(hidden)');
    expect(visibleName('xXyn7gfRxfXjwrXpk+mGPAZ3/RV2X/pS6GlGxPUS36Y=')).toBe('(hidden)');
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

test('leak: the closest-match list never prints the fake email, its hashes or a cookie value', async () => {
  const email = 'pw-fixture@example.com';
  const hex = createHash('sha256').update(email).digest('hex');
  const secrets = [
    email,
    hex,
    createHash('sha256').update(email).digest('base64'),
    createHash('sha256').update(email).digest('base64url'),
    'pwsession=Zk3Qm8Lp0Xv7Rt5Yb2Nc4Dd9Aa',
  ];
  const snapshot = [
    `- button "${email}"`,
    `- link "${hex}"`,
    `- option "${secrets[2]}"`,
    `- button "${secrets[3]}"`,
    `- link "${secrets[4]}"`,
    `- textbox "Contact": ${email}`,
    '- button "Buy now"',
  ].join('\n');
  const page = { locator: () => ({ ariaSnapshot: () => Promise.resolve(snapshot) }) } as never;
  const out = await timeoutMessage(page, 'Timeout.');
  for (const secret of secrets) expect(out).not.toContain(secret);
  expect(out).toContain('button "Buy now"');
});

describe('a role locator timeout', () => {
  const page = (snapshot: string) => ({ locator: () => ({ ariaSnapshot: () => Promise.resolve(snapshot) }) }) as never;
  const mixed = ['- link "Size guide"', '- button "Help"', '- radio "White (01)"', '- radio "Natural (02)"', '- radio "Black (03)"'].join('\n');

  test('lists the controls of the role, closest name first, and no other role', async () => {
    const out = await timeoutMessage(page(mixed), 'Timeout.', { role: 'radio', name: 'White (99)' });
    expect(out).toBe('Timeout. Closest radio controls: "White (01)", "Black (03)", "Natural (02)".');
  });

  test('ranks by shared words before page order', async () => {
    const out = await timeoutMessage(page('- radio "White (01)"\n- radio "Black (02)"'), 'Timeout.', { role: 'radio', name: 'Black (99)' });
    expect(out).toBe('Timeout. Closest radio controls: "Black (02)", "White (01)".');
  });

  test('keeps page order on equal scores', async () => {
    const out = await timeoutMessage(page('- radio "Aa"\n- radio "Bb"'), 'Timeout.', { role: 'radio', name: 'Zz' });
    expect(out).toBe('Timeout. Closest radio controls: "Aa", "Bb".');
  });

  test('says so and falls back to the first controls when the page has none of the role', async () => {
    const out = await timeoutMessage(page('- link "Size guide"\n- button "Help"'), 'Timeout.', { role: 'radio', name: 'x' });
    expect(out).toBe('Timeout. No radio controls on the page. Controls on the page: link "Size guide", button "Help".');
  });

  test('a locator without a name lists the role in page order', async () => {
    const out = await timeoutMessage(page(mixed), 'Timeout.', { role: 'radio' });
    expect(out).toBe('Timeout. Closest radio controls: "White (01)", "Natural (02)", "Black (03)".');
  });

  test('hides an email-like name', async () => {
    const out = await timeoutMessage(page('- radio "ada@example.com"'), 'Timeout.', { role: 'radio', name: 'x' });
    expect(out).toBe('Timeout. Closest radio controls: "(hidden)".');
  });

  test('lists at most ten', async () => {
    const many = Array.from({ length: 15 }, (_, i) => `- radio "R${i}"`).join('\n');
    const out = await timeoutMessage(page(many), 'Timeout.', { role: 'radio', name: 'R' });
    expect(out.match(/"R\d+"/g)).toHaveLength(10);
  });

  test('leak: never prints the fake email, its hashes or a cookie value', async () => {
    const email = 'pw-fixture@example.com';
    const secrets = [
      email,
      createHash('sha256').update(email).digest('hex'),
      createHash('sha256').update(email).digest('base64'),
      createHash('sha256').update(email).digest('base64url'),
      'pwsession=Zk3Qm8Lp0Xv7Rt5Yb2Nc4Dd9Aa',
    ];
    const snapshot = [
      ...secrets.map((s) => `- button "${s}"`),
      ...secrets.map((s) => `- link "${s}"`),
      '- button "Buy now"',
      '- link "Buy now"',
    ].join('\n');
    for (const role of ['button', 'link']) {
      const out = await timeoutMessage(page(snapshot), 'Timeout.', { role, name: email });
      for (const secret of secrets) expect(out).not.toContain(secret);
      expect(out).toContain('"Buy now"');
    }
  });
});
