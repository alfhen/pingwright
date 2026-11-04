import { describe, expect, test, vi } from 'vitest';
import { mergeOptions, parseProjectConfig, ProjectConfigError } from './project-config.ts';
import { parseScenario } from './scenario.ts';

const FILE = 'tagreeve/config.yml';
const head = 'configSchemaVersion: 1\n';

function errorOf(text: string): string {
  try {
    parseProjectConfig(text, FILE);
  } catch (e) {
    expect(e).toBeInstanceOf(ProjectConfigError);
    return (e as Error).message;
  }
  throw new Error('expected a ProjectConfigError');
}

describe('allowed keys', () => {
  test('a full config', () => {
    const config = parseProjectConfig(
      `${head}site: https://shop.example.com\nout: records\noptions:\n  allowUnknownDestination: true\n  builtins: { earlyIdentifiers: fail }\n  firstPartyHosts: [cdn.example.com]\n  platformHosts: false\n  serverHosts: [sgtm.example.com]\n  unloadGapIgnore: [consent_*]\n  identifierFields: [user_data.*]\n`,
      FILE,
    );
    expect(config).toEqual({
      site: 'https://shop.example.com',
      out: 'records',
      options: {
        allowUnknownDestination: true,
        builtins: { earlyIdentifiers: 'fail' },
        firstPartyHosts: ['cdn.example.com'],
        platformHosts: false,
        serverHosts: ['sgtm.example.com'],
        unloadGapIgnore: ['consent_*'],
        identifierFields: ['user_data.*'],
      },
    });
  });

  test('only the version', () => {
    expect(parseProjectConfig(head, FILE)).toEqual({ options: {} });
  });

  test('a loopback http site', () => {
    expect(parseProjectConfig(`${head}site: http://127.0.0.1:8080\n`, FILE).site).toBe('http://127.0.0.1:8080');
  });
});

describe('invalid values', () => {
  test.each([
    ['', 'must be a YAML mapping'],
    ['site: https://a.example.com\n', 'configSchemaVersion: required'],
    ['configSchemaVersion: 2\n', 'configSchemaVersion: must be 1'],
    [`${head}site: ftp://a.example.com\n`, 'site: must be an http or https URL'],
    [`${head}site: https://user:pw@a.example.com\n`, 'site: must be an http or https URL'],
    [`${head}site: 3\n`, 'site: must be an http or https URL'],
    [`${head}out: ''\n`, 'out: must be a folder path'],
    [`${head}options: 3\n`, 'options: must be a mapping'],
    [`${head}options: { allowUnknownDestination: maybe }\n`, 'options.allowUnknownDestination'],
    [`${head}options: { builtins: { nope: fail } }\n`, 'options.builtins.nope'],
    [`${head}options: { seed: 1 }\n`, 'options.seed: unknown key'],
    [`${head}options: { viewport: { width: 400, height: 800 } }\n`, 'options.viewport: unknown key'],
  ])('%j', (text, message) => {
    expect(errorOf(text)).toContain(message);
  });

  test('a bad YAML file names the file and the line, not the text', () => {
    const message = errorOf(`${head}site: [unclosed gtm_auth=SECRET\n`);
    expect(message).toContain(`${FILE}: line `);
    expect(message).not.toContain('SECRET');
  });

  test('a vendor host in serverHosts is named without its value', () => {
    const message = errorOf(`${head}options: { serverHosts: [www.google-analytics.com] }\n`);
    expect(message).toContain('options.serverHosts');
    expect(message).not.toContain('www.google-analytics.com');
  });

  test('a site with a password is not echoed', () => {
    expect(errorOf(`${head}site: https://user:FAKE-PW@a.example.com\n`)).not.toContain('FAKE-PW');
  });
});

describe('refused keys', () => {
  const secret = 'gtm_auth=FAKE-AUTH-VALUE';
  test.each(['network', 'serverContainer', 'serverContainerConfig', 'allowTestPayment', 'gtmOverride'])('%s at the top and in options names the key and line', (key) => {
    const top = errorOf(`${head}\n${key}: "${secret}"\n`);
    expect(top).toBe(`${FILE}: line 3, ${key}: not allowed in the project config. Pass it on the command line.`);
    const inOptions = errorOf(`${head}options:\n  ${key}: "${secret}"\n`);
    expect(inOptions).toContain(`${FILE}: line 3, options.${key}: not allowed`);
    expect(top + inOptions).not.toContain('FAKE-AUTH-VALUE');
  });

  test('a mapping value is never echoed', () => {
    const message = errorOf(`${head}serverContainerConfig:\n  container: FAKE-CONTAINER-CONFIG\n  gtmAuth: FAKE-AUTH-VALUE\n`);
    expect(message).toContain('line 2, serverContainerConfig');
    expect(message).not.toMatch(/FAKE/);
  });

  test.each([
    ['an unresolved alias', `${head}options:\n  gtmOverride: *gtm_auth=FAKE-AUTH-VALUE\n`, 'line 3: not valid YAML (unresolved alias)'],
    ['an unquoted wildcard host', `${head}options:\n  firstPartyHosts: *.example.com\n`, 'line 3: not valid YAML (unresolved alias)'],
    ['a collection key', `${head}? { gtmOverride: "gtm_auth=FAKE-AUTH-VALUE" }\n: x\n`, 'line 2: a key must be a plain name'],
  ])('%s names the line and never the text', (_, text, message) => {
    const warn = vi.spyOn(process, 'emitWarning');
    const out = errorOf(text);
    expect(out).toBe(`${FILE}: ${message}`);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test('an unknown key', () => {
    expect(errorOf(`${head}colour: red\n`)).toBe(`${FILE}: line 2, colour: unknown key, expected one of configSchemaVersion, site, out, options`);
  });

  test('all problems are listed', () => {
    expect(errorOf(`${head}network: live\ncolour: red\n`).split('\n')).toHaveLength(2);
  });
});

describe('mergeOptions', () => {
  test('the scenario wins and a list replaces the config list', () => {
    const merged = mergeOptions({ allowUnknownDestination: true, firstPartyHosts: ['a.example.com'], platformHosts: false }, { allowUnknownDestination: false, firstPartyHosts: ['b.example.com'] });
    expect(merged).toEqual({ allowUnknownDestination: false, firstPartyHosts: ['b.example.com'], platformHosts: false });
  });

  test('builtins merge per check and the scenario wins', () => {
    const merged = mergeOptions({ builtins: { unknownDestination: 'warn', earlyIdentifiers: 'fail' } }, { builtins: { unknownDestination: 'fail' } });
    expect(merged.builtins).toEqual({ unknownDestination: 'fail', earlyIdentifiers: 'fail' });
  });

  test('a scenario with network server and no serverHosts takes the config hosts', () => {
    const scenario = parseScenario('start: /\noptions: { network: server }\n');
    expect(mergeOptions({ serverHosts: ['sgtm.example.com'] }, scenario.options)).toEqual({ network: 'server', serverHosts: ['sgtm.example.com'] });
  });

  test('config options stay when the scenario has none', () => {
    expect(mergeOptions({ unloadGapIgnore: ['x_*'] }, {})).toEqual({ unloadGapIgnore: ['x_*'] });
  });
});
