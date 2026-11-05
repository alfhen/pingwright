import { expect, test } from 'vitest';
import { helpText, parseCli, UsageError } from './args.ts';

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
    out: undefined,
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
  expect(parseCli(['init'])).toEqual({ command: 'init', json: false });
  expect(parseCli(['init', '--json'])).toEqual({ command: 'init', json: true });
  expect(() => parseCli(['init', '--site', 'https://x.example'])).toThrow('init does not take --site');
  expect(() => parseCli(['init', 'x'])).toThrow('init takes no arguments');
  expect(parseCli(['template', 'web'])).toEqual({ command: 'template', name: 'web', json: false });
  expect(parseCli(['template', 'web', '--json'])).toEqual({ command: 'template', name: 'web', json: true });
  expect(() => parseCli(['template'])).toThrow('template needs a name');
  expect(() => parseCli(['template', 'server'])).toThrow('template needs a name');
  expect(() => parseCli(['template', 'web', 'x'])).toThrow('template needs a name');
  expect(() => parseCli(['template', 'web', '--site', 'https://x.example'])).toThrow('template does not take --site');
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
  expect(parseCli(suiteBase)).toMatchObject({ command: 'suite', dir: 'dir', variants: [{ name: 'published' }], out: undefined, withHandoff: false, json: false });
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

test('suite takes at most one directory and needs no site at parse time', () => {
  expect(() => parseCli(['suite', 'a', 'b'])).toThrow('at most one scenario directory');
  expect(parseCli(['suite', 'dir'])).toMatchObject({ command: 'suite', dir: 'dir' });
  const bare = parseCli(['suite']);
  expect(bare).toMatchObject({ command: 'suite' });
  expect(bare).not.toHaveProperty('dir');
  expect(bare).not.toHaveProperty('site');
  expect(bare).not.toHaveProperty('stores');
});

test('suite takes --stores instead of --site, never both, and run refuses it', () => {
  const parsed = parseCli(['suite', 'dir', '--stores', 'stores.json']);
  expect(parsed).toMatchObject({ command: 'suite', stores: 'stores.json' });
  expect(parsed).not.toHaveProperty('site');
  expect(() => parseCli(['suite', 'dir', '--stores', 's.json', '--site', 'https://x.test'])).toThrow('cannot be used together');
  expect(() => parseCli(['run', 's.yml', '--site', 'https://x.test', '--stores', 's.json'])).toThrow('--stores is not an option of run');
  expect(() => parseCli(['run', 's.yml', '--stores', 's.json'])).toThrow('--stores is not an option of run');
});

test('run needs no site at parse time and both commands take --config', () => {
  const run = parseCli(['run', 's.yml']);
  expect(run).toMatchObject({ command: 'run', scenario: 's.yml' });
  expect(run).not.toHaveProperty('site');
  expect(run).not.toHaveProperty('config');
  expect(parseCli(['run', 's.yml', '--config', 'other.yml'])).toMatchObject({ config: 'other.yml' });
  expect(parseCli(['suite', '--config', 'other.yml'])).toMatchObject({ command: 'suite', config: 'other.yml' });
  expect(parseCli(['suite'])).not.toHaveProperty('config');
});

test.each([
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
  [['--sitee', 'http://x', 'run', 's.yml'], 'run'],
  [['--jsno', 'run', 's.yml', '--site', 'http://x'], 'run'],
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

test('an unknown option is one short line', () => {
  for (const argv of [['run', 's.yml', '--site', 'http://x.test', '--bogus'], ['--bogus'], ['diff', '-x']]) {
    const flag = argv.find((a) => a === '--bogus' || a === '-x')!;
    let error: unknown;
    try {
      parseCli(argv);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`Unknown option ${flag}.`);
  }
});

test.each(['run', 'suite', 'diff', 'baseline', 'report', 'init', 'template', 'install-browser', 'server-container'] as const)('%s --help prints the help of that command', (command) => {
  expect(parseCli([command, '--help'])).toEqual({ command: 'help', topic: command });
  expect(helpText(command)).toContain(`Usage: tagreeve ${command}`);
});

test('diff help lists the diff options, not the run options', () => {
  const text = helpText('diff');
  expect(text).toContain('--across-frames');
  expect(text).toContain('--all-flags');
  expect(text).toContain('--by-page');
  expect(text).not.toContain('--network');
});

test('diff help says --all-flags also covers platform hosts', () => {
  expect(helpText('diff')).toContain('and for platform hosts');
});

test('suite help lists the suite options', () => {
  expect(helpText('suite')).toContain('--with-handoff');
  expect(helpText('suite')).toContain('--stores');
});

test.each([
  ['run', ['run', 's.yml', '--site', 'http://x.test']],
  ['suite', ['suite', 'dir', '--site', 'http://x.test']],
])('--label on %s takes 1 to 40 lowercase letters, digits and hyphens', (_name, argv) => {
  expect(parseCli([...argv, '--label', 'a'.repeat(40)])).toMatchObject({ label: 'a'.repeat(40) });
  expect(parseCli([...argv, '--label', 'ca-307-live'])).toMatchObject({ label: 'ca-307-live' });
  expect(parseCli(argv)).not.toHaveProperty('label');
  for (const bad of ['a'.repeat(41), 'Bad_Label', '', 'a b']) {
    expect(() => parseCli([...argv, '--label', bad])).toThrow(`--label must be 1 to 40 lowercase letters, digits or hyphens, got "${bad}"`);
  }
  expect(helpText(argv[0] as 'run' | 'suite')).toContain('--label');
});

test('a bare --baseline at the end, or before another option, means the default; a value is the path', () => {
  const site = ['--site', 'http://localhost:1'];
  expect(parseCli(['run', 's.yml', ...site, '--baseline'])).toMatchObject({ baselineDefault: true, baseline: undefined });
  expect(parseCli(['run', 's.yml', '--baseline', '--json', ...site])).toMatchObject({ baselineDefault: true, baseline: undefined, json: true });
  expect(parseCli(['run', 's.yml', ...site, '--baseline', 'b.json'])).toMatchObject({ baseline: 'b.json' });
  expect(parseCli(['run', 's.yml', ...site, '--baseline', 'b.json'])).not.toHaveProperty('baselineDefault');
  expect(parseCli(['run', 's.yml', ...site])).not.toHaveProperty('baselineDefault');
  expect(parseCli(['suite', ...site, '--baseline'])).toMatchObject({ baselineDefault: true });
  expect(parseCli(['suite', ...site, '--baseline'])).not.toHaveProperty('baseline');
  expect(parseCli(['suite', 'dir', ...site, '--baseline', 'folder'])).toMatchObject({ dir: 'dir', baseline: 'folder' });
});
