import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScenario } from '@tagreeve/expect';
import { expect, test } from 'vitest';
import { acceptsDeclaration, checkTestPaymentGates, readTestPaymentHosts, testPaymentHostsPath } from './test-payment-hosts.ts';

const scenario = (provider = 'shopify-bogus') =>
  parseScenario(`start: /\nsteps:\n  - payment: { provider: ${provider}, card: "${provider === 'shopify-bogus' ? '1' : '4242424242424242'}" }\n`);
const plain = parseScenario('start: /\nsteps:\n  - visit: /\n');

async function configDir(content: string | undefined, mode = 0o600): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), 'pw-tph-'));
  if (content !== undefined) {
    await mkdir(join(root, 'tagreeve'));
    const file = join(root, 'tagreeve', 'test-payment-hosts.json');
    await writeFile(file, content);
    await chmod(file, mode);
  }
  return { XDG_CONFIG_HOME: root };
}

test('the file is under XDG_CONFIG_HOME, else ~/.config', () => {
  expect(testPaymentHostsPath({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u')).toBe('/x/cfg/tagreeve/test-payment-hosts.json');
  expect(testPaymentHostsPath({}, '/home/u')).toBe('/home/u/.config/tagreeve/test-payment-hosts.json');
  expect(testPaymentHostsPath({ XDG_CONFIG_HOME: 'relative' }, '/home/u')).toBe('/home/u/.config/tagreeve/test-payment-hosts.json');
});

test('the allowlist reads exact hosts', async () => {
  const env = await configDir('["Shop.Example.com", "localhost"]');
  expect(await readTestPaymentHosts(testPaymentHostsPath(env))).toEqual([{ host: 'shop.example.com' }, { host: 'localhost' }]);
});

test.each([
  ['a missing file', undefined, 0o600, 'does not exist'],
  ['bad JSON', '{nope', 0o600, 'not valid JSON'],
  ['a JSON value that is not a list', '{}', 0o600, 'JSON array of host names'],
  ['an entry that is a number', '[1]', 0o600, 'entry 0 must be a host name or an object'],
  ['an entry with an extra key', '[{"host":"a.example.com","testMode":"shopify-test","x":1}]', 0o600, 'entry 0 must be a host name or an object'],
  ['an entry without a testMode', '["a.example.com",{"host":"a.example.com"}]', 0o600, 'entry 1 must be'],
  ['a file that others can write', '["localhost"]', 0o666, 'must not be writable by group or others'],
  ['a file that the group can write', '["localhost"]', 0o620, 'must not be writable by group or others'],
])('the allowlist refuses %s', async (_name, content, mode, message) => {
  const env = await configDir(content, mode);
  await expect(readTestPaymentHosts(testPaymentHostsPath(env))).rejects.toThrow(message);
});

test('a scenario without a payment step needs no flag and no file', async () => {
  expect(await checkTestPaymentGates(plain, 'https://shop.example.com', undefined, await configDir(undefined))).toEqual({ ok: true });
});

test('all gates pass when the flag names the site host and the file lists it', async () => {
  const env = await configDir('["shop.example.com"]');
  expect(await checkTestPaymentGates(scenario(), 'https://shop.example.com/some/path', 'shop.example.com', env)).toEqual({
    ok: true,
    testPayment: { host: 'shop.example.com' },
  });
});

test('no flag fails', async () => {
  const env = await configDir('["shop.example.com"]');
  const gates = await checkTestPaymentGates(scenario(), 'https://shop.example.com', undefined, env);
  expect(gates.ok).toBe(false);
  expect(gates.ok ? '' : gates.error).toContain('--allow-test-payment shop.example.com');
});

test('a flag that names another host fails, even when that host is listed', async () => {
  const env = await configDir('["shop.example.com", "other.example.com"]');
  const gates = await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'other.example.com', env);
  expect(gates.ok ? '' : gates.error).toContain('must name the --site host');
});

test('a host that is not in the file fails', async () => {
  const env = await configDir('["other.example.com"]');
  const gates = await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'shop.example.com', env);
  expect(gates.ok ? '' : gates.error).toContain('is not in');
});

test('a missing or unsafe file fails', async () => {
  const gates = await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'shop.example.com', await configDir(undefined));
  expect(gates.ok).toBe(false);
  const open = await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'shop.example.com', await configDir('["shop.example.com"]', 0o666));
  expect(open.ok ? '' : open.error).toContain('must not be writable');
});

test('the fixture provider is only for a loopback site, whatever the flag and the file say', async () => {
  const env = await configDir('["shop.example.com", "localhost"]');
  const hosted = await checkTestPaymentGates(scenario('fixture'), 'https://shop.example.com', 'shop.example.com', env);
  expect(hosted.ok ? '' : hosted.error).toContain('only for loopback sites');
  expect((await checkTestPaymentGates(scenario('fixture'), 'http://localhost:3000', 'localhost', env)).ok).toBe(true);
});

test('declarations are read next to plain hosts', async () => {
  const env = await configDir('["a.example.com", { "host": "Shop.Example.com", "testMode": "shopify-test" }]');
  expect(await readTestPaymentHosts(testPaymentHostsPath(env))).toEqual([{ host: 'a.example.com' }, { host: 'shop.example.com', testMode: 'shopify-test' }]);
});

test('a typo in the provider id is an error that names the file and the entry, not the typo', async () => {
  const env = await configDir('["a.example.com", { "host": "shop.example.com", "testMode": "shopify-tset" }]');
  const path = testPaymentHostsPath(env);
  const error = await readTestPaymentHosts(path).catch((e: Error) => e);
  expect((error as Error).message).toContain(path);
  expect((error as Error).message).toContain('entry 1');
  expect((error as Error).message).not.toContain('shopify-tset');
  expect((error as Error).message).not.toContain('shop.example.com');
});

test.each([
  ['a loopback host with a hosted provider', { host: 'localhost', testMode: 'shopify-test' }],
  ['the fixture provider on a hosted host', { host: 'shop.example.com', testMode: 'fixture' }],
])('a declaration with %s is refused, with or without the seam', async (_name, entry) => {
  const env = await configDir(JSON.stringify([entry]));
  const path = testPaymentHostsPath(env);
  await expect(readTestPaymentHosts(path, false)).rejects.toThrow('entry 0');
  await expect(readTestPaymentHosts(path, true)).rejects.toThrow('entry 0');
});

test('the fixture provider on a loopback host is a declaration only under the test seam', async () => {
  const env = await configDir('[{ "host": "localhost", "testMode": "fixture" }]');
  const path = testPaymentHostsPath(env);
  await expect(readTestPaymentHosts(path, false)).rejects.toThrow('entry 0');
  expect(await readTestPaymentHosts(path, true)).toEqual([{ host: 'localhost', testMode: 'fixture' }]);
});

test('a declared host passes the gates and carries its declared providers', async () => {
  const env = await configDir('["shop.example.com", { "host": "shop.example.com", "testMode": "shopify-bogus" }, { "host": "other.example.com", "testMode": "shopify-test" }]');
  expect(await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'shop.example.com', env)).toEqual({
    ok: true,
    testPayment: { host: 'shop.example.com', declaredProviders: ['shopify-bogus'] },
  });
});

test('a declaration for the host is enough to be listed, and the flag must still name the site host', async () => {
  const env = await configDir('[{ "host": "shop.example.com", "testMode": "shopify-bogus" }]');
  expect((await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'shop.example.com', env)).ok).toBe(true);
  const other = await checkTestPaymentGates(scenario(), 'https://shop.example.com', 'other.example.com', env);
  expect(other.ok ? '' : other.error).toContain('must name the --site host');
});

test('the allowlist file accepts a hosted host with a real provider, and a loopback host with fixture only under the seam', () => {
  expect(acceptsDeclaration('shop.example.com', 'shopify-test', false)).toBe(true);
  expect(acceptsDeclaration('shop.example.com', 'fixture', false)).toBe(false);
  expect(acceptsDeclaration('shop.example.com', 'fixture', true)).toBe(false);
  expect(acceptsDeclaration('localhost', 'fixture', false)).toBe(false);
  expect(acceptsDeclaration('localhost', 'fixture', true)).toBe(true);
  expect(acceptsDeclaration('127.0.0.1', 'shopify-test', true)).toBe(false);
  expect(acceptsDeclaration('Shop.Example.com', 'shopify-test', false)).toBe(true);
});
