import { expect, test } from 'vitest';
import { parseCli, UsageError } from './args.ts';

test('parses run with every option', () => {
  expect(
    parseCli([
      'run', 's.yml', '--site', 'http://localhost:3000', '--network', 'live', '--out', 'o', '--seed', '7', '--headed',
      '--autoconsent-rules', 'a.json', '--autoconsent-rules', 'b.json', '--var', 'product=tee', '--var', 'q=a=b', '--gtm-override', 'g.json', '--tracker-list', 't.json', '--json', '--net-log',
    ]),
  ).toEqual({
    command: 'run',
    scenario: 's.yml',
    site: 'http://localhost:3000',
    network: 'live',
    out: 'o',
    seed: 7,
    headed: true,
    netLog: true,
    autoconsentRules: ['a.json', 'b.json'],
    gtmOverride: 'g.json',
    trackerList: 't.json',
    vars: { product: 'tee', q: 'a=b' },
    json: true,
  });
});

test('--net-log is parsed with any network flag; the run command checks the mode', () => {
  const base = ['run', 's.yml', '--site', 'http://localhost:3000', '--net-log'];
  expect(parseCli(base)).toMatchObject({ netLog: true, network: undefined });
  expect(parseCli([...base, '--network', 'stub'])).toMatchObject({ netLog: true, network: 'stub' });
  expect(parseCli([...base, '--network', 'live'])).toMatchObject({ netLog: true, network: 'live' });
});

test('run defaults', () => {
  expect(parseCli(['run', 's.yml', '--site', 'https://example.com'])).toMatchObject({
    network: undefined,
    out: 'runs',
    seed: undefined,
    headed: false,
    netLog: false,
    autoconsentRules: [],
    vars: {},
    json: false,
  });
});

test('other commands', () => {
  expect(parseCli(['--version'])).toEqual({ command: 'version' });
  expect(parseCli(['install-browser'])).toEqual({ command: 'install-browser' });
  expect(parseCli([])).toEqual({ command: 'help' });
  expect(parseCli(['run', '--help'])).toEqual({ command: 'help', topic: 'run' });
  expect(parseCli(['--help'])).toEqual({ command: 'help' });
});

test('server-container build', () => {
  expect(parseCli(['server-container', 'build'])).toEqual({ command: 'server-container', action: 'build' });
  expect(() => parseCli(['server-container'])).toThrow('needs a subcommand');
  expect(() => parseCli(['server-container', 'push'])).toThrow('needs a subcommand');
  expect(() => parseCli(['server-container', 'build', 'extra'])).toThrow('takes no arguments');
});

const suiteBase = ['suite', 'dir', '--site', 'https://shop.example.com'];

test('suite defaults to the published variant', () => {
  expect(parseCli(suiteBase)).toMatchObject({ command: 'suite', dir: 'dir', variants: [{ name: 'published' }], out: 'runs', withHandoff: false, json: false });
});

test('suite parses variants, name=file and the options of run', () => {
  const parsed = parseCli([...suiteBase, '--variant', 'published', '--variant', 'workspace=a=b/o.json', '--with-handoff', '--network', 'live', '--seed', '3', '--var', 'k=v', '--json']);
  expect(parsed).toMatchObject({
    variants: [{ name: 'published' }, { name: 'workspace', file: 'a=b/o.json' }],
    withHandoff: true,
    network: 'live',
    seed: 3,
    vars: { k: 'v' },
    json: true,
  });
});

test.each([
  [['--variant', 'Bad Name=f.json'], 'must match'],
  [['--variant', 'published=f.json'], 'reserved'],
  [['--variant', 'workspace'], 'needs an override file'],
  [['--variant', 'workspace='], 'needs an override file'],
  [['--variant', 'published', '--variant', 'published'], 'given twice'],
  [['--variant', 'a=x.json', '--variant', 'a=y.json'], 'given twice'],
  [['--gtm-override', 'g.json'], 'not an option of suite'],
  [['--headed'], 'not an option of suite'],
  [['--network', 'bogus'], 'stub, server or live'],
])('suite usage error for %j', (extra, message) => {
  expect(() => parseCli([...suiteBase, ...extra])).toThrow(UsageError);
  expect(() => parseCli([...suiteBase, ...extra])).toThrow(message);
});

test('suite takes one directory and needs --site', () => {
  expect(() => parseCli(['suite', '--site', 'https://x.test'])).toThrow('one scenario directory');
  expect(() => parseCli(['suite', 'dir'])).toThrow('--site or --stores is required');
});

test('suite takes --stores instead of --site, never both, and run refuses it', () => {
  const parsed = parseCli(['suite', 'dir', '--stores', 'stores.json']);
  expect(parsed).toMatchObject({ command: 'suite', stores: 'stores.json' });
  expect(parsed).not.toHaveProperty('site');
  expect(() => parseCli(['suite', 'dir', '--stores', 's.json', '--site', 'https://x.test'])).toThrow('cannot be used together');
  expect(() => parseCli(['run', 's.yml', '--site', 'https://x.test', '--stores', 's.json'])).toThrow('--stores is not an option of run');
  expect(() => parseCli(['run', 's.yml', '--stores', 's.json'])).toThrow('--site is required');
});

test.each([
  [['run', 's.yml'], '--site is required'],
  [['run', '--site', 'http://x.test'], 'one scenario file'],
  [['run', 's.yml', '--site', 'ftp://x.test'], 'http or https'],
  [['run', 's.yml', '--site', 'nope'], 'http or https'],
  [['run', 's.yml', '--site', 'http://x.test', '--network', 'bogus'], 'stub, server or live'],
  [['run', 's.yml', '--site', 'http://x.test', '--seed', 'x'], 'non-negative integer'],
  [['run', 's.yml', '--site', 'http://x.test', '--var', 'novalue'], 'name=value'],
  [['run', 's.yml', '--site', 'http://x.test', '--bogus'], 'bogus'],
  [['run', 's.yml', '--site', 'http://x.test', '--variant', 'workspace=o.json'], 'not an option of run'],
  [['run', 's.yml', '--site', 'http://x.test', '--with-handoff'], 'not an option of run'],
  [['dance'], 'Unknown command'],
])('usage error for %j', (argv, message) => {
  expect(() => parseCli(argv)).toThrow(UsageError);
  expect(() => parseCli(argv)).toThrow(message);
});

test.each([
  [['nope', 'run'], undefined],
  [['--out', 'report', 'nope'], undefined],
  [['--out', 'report', 'run'], 'run'],
  [['diff', 'a'], 'diff'],
])('usage error for %j carries command %s', (argv, command) => {
  let error: unknown;
  try {
    parseCli(argv);
  } catch (e) {
    error = e;
  }
  expect((error as UsageError).command).toBe(command);
});

test('--network server is accepted by run and suite', () => {
  expect(parseCli(['run', 's.yml', '--site', 'http://x.test', '--network', 'server'])).toMatchObject({ network: 'server' });
  expect(parseCli([...suiteBase, '--network', 'server'])).toMatchObject({ network: 'server' });
});

test('--viewport takes WxH on run and suite', () => {
  expect(parseCli(['run', 's.yml', '--site', 'http://x.test', '--viewport', '390x844'])).toMatchObject({ viewport: { width: 390, height: 844 } });
  expect(parseCli([...suiteBase, '--viewport', '1280x720'])).toMatchObject({ viewport: { width: 1280, height: 720 } });
  expect(parseCli(['run', 's.yml', '--site', 'http://x.test'])).not.toHaveProperty('viewport');
});

test.each(['mobile', '390', '390x', 'x844', '390X844', '199x844', '390x4001', '390x844x1', '-390x844', ''])('--viewport "%s" is a usage error', (value) => {
  expect(() => parseCli(['run', 's.yml', '--site', 'http://x.test', '--viewport', value])).toThrow(UsageError);
});

test('run and suite take --allow-test-payment, suite also --with-test-payment', () => {
  expect(parseCli(['run', 's.yml', '--site', 'http://x.test', '--allow-test-payment', 'x.test'])).toMatchObject({ command: 'run', allowTestPayment: 'x.test' });
  expect(parseCli(['run', 's.yml', '--site', 'http://x.test'])).not.toHaveProperty('allowTestPayment');
  expect(parseCli([...suiteBase, '--with-test-payment', '--allow-test-payment', 'shop.example.com'])).toMatchObject({
    withTestPayment: true,
    allowTestPayment: 'shop.example.com',
  });
  expect(parseCli(suiteBase)).toMatchObject({ withTestPayment: false });
  expect(() => parseCli(['run', 's.yml', '--site', 'http://x.test', '--with-test-payment'])).toThrow('not an option of run');
  expect(() => parseCli(['run', 's.yml', '--site', 'http://x.test', '--allow-test-payment'])).toThrow(UsageError);
});

test('--server-container and --server-container-config are parsed on run and suite', () => {
  expect(parseCli(['run', 's.yml', '--site', 'http://localhost:3000', '--server-container', '--server-container-config', 'c.txt'])).toMatchObject({
    command: 'run',
    serverContainer: true,
    serverContainerConfig: 'c.txt',
  });
  expect(parseCli(['suite', 'dir', '--site', 'http://localhost:3000', '--server-container'])).toMatchObject({ command: 'suite', serverContainer: true });
});

test('without the flag the args carry no server container field', () => {
  expect(parseCli(['run', 's.yml', '--site', 'http://localhost:3000'])).not.toHaveProperty('serverContainer');
  expect(parseCli(['suite', 'dir', '--site', 'http://localhost:3000'])).not.toHaveProperty('serverContainerConfig');
});

test.each([
  ['run', ['run', 's.yml', '--site', 'http://localhost:3000']],
  ['suite', ['suite', 'dir', '--site', 'http://localhost:3000']],
])('--server-container-config without --server-container is a usage error on %s', (_name, argv) => {
  expect(() => parseCli([...argv, '--server-container-config', 'c.txt'])).toThrow('--server-container-config needs --server-container');
});
