import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScenario } from '@tagreeve/expect';
import { expect, test } from 'vitest';
import { checkTestPaymentGates, readTestPaymentHosts, testPaymentHostsPath } from './test-payment-hosts.ts';

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
  expect(await readTestPaymentHosts(testPaymentHostsPath(env))).toEqual(['shop.example.com', 'localhost']);
});

test.each([
  ['a missing file', undefined, 0o600, 'does not exist'],
  ['bad JSON', '{nope', 0o600, 'not valid JSON'],
  ['a JSON value that is not a list of strings', '[1]', 0o600, 'JSON array of host names'],
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
