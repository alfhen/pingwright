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
  [['--network', 'server'], 'stub or live'],
])('suite usage error for %j', (extra, message) => {
  expect(() => parseCli([...suiteBase, ...extra])).toThrow(UsageError);
  expect(() => parseCli([...suiteBase, ...extra])).toThrow(message);
});

test('suite takes one directory and needs --site', () => {
  expect(() => parseCli(['suite', '--site', 'https://x.test'])).toThrow('one scenario directory');
  expect(() => parseCli(['suite', 'dir'])).toThrow('--site is required');
});

test.each([
  [['run', 's.yml'], '--site is required'],
  [['run', '--site', 'http://x.test'], 'one scenario file'],
  [['run', 's.yml', '--site', 'ftp://x.test'], 'http or https'],
  [['run', 's.yml', '--site', 'nope'], 'http or https'],
  [['run', 's.yml', '--site', 'http://x.test', '--network', 'server'], 'stub or live'],
  [['run', 's.yml', '--site', 'http://x.test', '--seed', 'x'], 'non-negative integer'],
  [['run', 's.yml', '--site', 'http://x.test', '--var', 'novalue'], 'name=value'],
  [['run', 's.yml', '--site', 'http://x.test', '--bogus'], 'bogus'],
  [['dance'], 'Unknown command'],
])('usage error for %j', (argv, message) => {
  expect(() => parseCli(argv)).toThrow(UsageError);
  expect(() => parseCli(argv)).toThrow(message);
});
