import { expect, test } from 'vitest';
import { parseCli, UsageError } from './args.ts';

test('parses run with every option', () => {
  expect(
    parseCli([
      'run', 's.yml', '--site', 'http://localhost:3000', '--network', 'live', '--out', 'o', '--seed', '7', '--headed',
      '--autoconsent-rules', 'a.json', '--autoconsent-rules', 'b.json', '--var', 'product=tee', '--var', 'q=a=b', '--gtm-override', 'g.json', '--json',
    ]),
  ).toEqual({
    command: 'run',
    scenario: 's.yml',
    site: 'http://localhost:3000',
    network: 'live',
    out: 'o',
    seed: 7,
    headed: true,
    autoconsentRules: ['a.json', 'b.json'],
    gtmOverride: 'g.json',
    vars: { product: 'tee', q: 'a=b' },
    json: true,
  });
});

test('run defaults', () => {
  expect(parseCli(['run', 's.yml', '--site', 'https://example.com'])).toMatchObject({
    network: undefined,
    out: 'runs',
    seed: undefined,
    headed: false,
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
