import { expect, test } from 'vitest';
import { redactHeaders } from './redact.ts';

const value = 'pwfake-cookie-value-9f3a';

test.each(['Cookie', 'set-cookie', 'Set-Cookie', 'Authorization', 'PROXY-AUTHORIZATION'])(
  'redacts the %s header',
  (name) => {
    const out = redactHeaders({ [name]: value, accept: 'text/html' });
    expect(out[name]).toBe('[redacted]');
    expect(out.accept).toBe('text/html');
    expect(JSON.stringify(out)).not.toContain(value);
  },
);
