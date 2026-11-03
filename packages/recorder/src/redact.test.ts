import { expect, test } from 'vitest';
import { redactHeaders, redactSecretsInBody, redactSecretsInUrl } from './redact.ts';

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

test.each(['Access-Token', 'x-api-key', 'X-API-KEY'])('redacts the %s header', (name) => {
  const out = redactHeaders({ [name]: value, accept: 'text/html' });
  expect(out[name]).toBe('[redacted]');
  expect(out.accept).toBe('text/html');
});

test('redacts access_token and appsecret_proof in a URL, whatever their position', () => {
  const token = 'pw-fixture-access-token';
  expect(redactSecretsInUrl(`https://graph.facebook.com/v21.0/1/events?access_token=${token}&a=1`)).toBe('https://graph.facebook.com/v21.0/1/events?access_token=[redacted]&a=1');
  expect(redactSecretsInUrl(`https://x.example/p?a=1&appsecret_proof=${token}#f`)).toBe('https://x.example/p?a=1&appsecret_proof=[redacted]#f');
  expect(redactSecretsInUrl('https://x.example/p?a=1')).toBe('https://x.example/p?a=1');
});

test('redacts the names in form and JSON bodies and leaves other fields', () => {
  const token = 'pw-fixture-access-token';
  expect(redactSecretsInBody(`access_token=${token}&a=1`)).toBe('access_token=[redacted]&a=1');
  expect(redactSecretsInBody(`a=1&appsecret_proof=${token}`)).toBe('a=1&appsecret_proof=[redacted]');
  expect(JSON.parse(redactSecretsInBody(`{"access_token":"${token}","n":{"appsecret_proof":"a\\"b"},"k":[1]}`))).toEqual({ access_token: '[redacted]', n: { appsecret_proof: '[redacted]' }, k: [1] });
  expect(redactSecretsInBody('{"data":[]}')).toBe('{"data":[]}');
});
