import { expect, test } from 'vitest';
import { README_QUICKSTART_SCENARIO, README_SCENARIO } from './readme-scenario.ts';
import { parseScenario, ScenarioError } from './scenario.ts';

test('parses the README quick start scenario', () => {
  const s = parseScenario(README_QUICKSTART_SCENARIO);
  expect(s.steps[0]).toMatchObject({ kind: 'consent' });
  expect(s.expect.mustNot[0]).toMatchObject({ before: 'consent' });
});

function errorOf(text: string): string {
  try {
    parseScenario(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ScenarioError);
    return (e as Error).message;
  }
  throw new Error('expected a ScenarioError');
}

test('parses the README example', () => {
  const s = parseScenario(README_SCENARIO);
  expect(s.start).toBe('/products/{product}');
  expect(s.steps.map((x) => x.kind)).toEqual(['consent', 'wait', 'visit']);
  expect(s.steps[1]).toMatchObject({ kind: 'wait', value: 4000 });
  expect(s.expect.mustNot).toHaveLength(2);
  expect(s.expect.mustNot[0]).toMatchObject({ before: 'consent', filter: { vendor: ['pinterest', 'meta', 'tiktok'] } });
  expect(s.expect.mustNot[1]!.filter).toMatchObject({ vendor: ['ga4'], ids: { user_id: 'present' }, consent: { analytics: 'denied' } });
  expect(s.expect.must[0]).toMatchObject({ count: { op: '>=', n: 2 }, filter: { event: ['page_view'] } });
});

test('accepts nested filter groups, page matches, in, after, options and all step kinds', () => {
  const s = parseScenario(`
start: /
steps:
  - visit: /
  - click: "#buy"
  - fill: { "input[name=email]": email }
  - consent: accept
  - wait: 500ms
  - addToCart: "button.add"
  - evaluate: "window.x = 1"
  - checkpoint: after-accept
  - handoff: pay by hand
expect:
  must:
    - vendor: meta
      ids: { em: present }
      consent: { ads: granted }
      params: { ev: Purchase }
      page: { matches: "^http://localhost" }
      in: epoch(granted)
      after: after-accept
      identity.hashesMatch: true
      count: 0
      host: [localhost]
      outcome: stubbed
      transport: image
options: { network: live, seed: 7, consentTimeout: 10s, graceWindow: 100ms, allowUnknownDestination: true }
`);
  expect(s.steps).toHaveLength(9);
  expect(s.expect.must[0]).toMatchObject({ inEpoch: 'granted', after: 'after-accept', hashesMatch: true, count: { op: '=', n: 0 } });
  expect(s.expect.must[0]!.filter.page).toEqual({ matches: '^http://localhost' });
  expect(s.options).toEqual({ network: 'live', seed: 7, consentTimeout: 10_000, graceWindow: 100, allowUnknownDestination: true });
});

test('parses counts', () => {
  const s = parseScenario(`start: /\nexpect:\n  must:\n    - { vendor: ga4, count: "<3" }\n    - { vendor: ga4, count: 2 }\n`);
  expect(s.expect.must.map((r) => r.count)).toEqual([{ op: '<', n: 3 }, { op: '=', n: 2 }]);
});

test('names the line and key of an unknown filter', () => {
  const msg = errorOf(`start: /\nexpect:\n  must:\n    - vendor: ga4\n      colour: red\n`);
  expect(msg).toContain('line 5');
  expect(msg).toContain('expect.must[0].colour');
});

test('names the line of a bad consent value', () => {
  const msg = errorOf(`start: /\nexpect:\n  mustNot:\n    - { vendor: ga4, consent.analytics: maybe }\n`);
  expect(msg).toMatch(/line 4: expect\.mustNot\[0\]\.consent\.analytics: must be one of granted, denied, unknown/);
});

test('rejects an unknown step and a multi-key step', () => {
  expect(errorOf(`start: /\nsteps:\n  - dance: now\n`)).toMatch(/line 3: steps\[0\]\.dance: unknown step/);
  expect(errorOf(`start: /\nsteps:\n  - { visit: /, click: a }\n`)).toMatch(/line 3: steps\[0\]: a step is a mapping with exactly one key/);
});

test('rejects a bad duration, consent answer and network', () => {
  expect(errorOf(`start: /\nsteps:\n  - wait: [soon]\n`)).toContain('steps[0].wait');
  expect(errorOf(`start: /\nsteps:\n  - consent: maybe\n`)).toContain('steps[0].consent');
  expect(errorOf(`start: /\noptions:\n  network: fast\n`)).toMatch(/line 3: options\.network/);
});

test('requires start and rejects unknown top-level keys', () => {
  expect(errorOf(`steps: []\n`)).toContain('start: required');
  expect(errorOf(`start: /\nexpects: {}\n`)).toContain('line 2: expects: unknown key');
});

test('rejects a variable that is not defined', () => {
  expect(errorOf(`start: /products/{product}\n`)).toContain('uses {product}');
});

test('rejects count under mustNot, hashesMatch under mustNot, before with in, bad regex, bad epoch', () => {
  expect(errorOf(`start: /\nexpect:\n  mustNot:\n    - { vendor: ga4, count: 2 }\n`)).toContain('only valid under must');
  expect(errorOf(`start: /\nexpect:\n  mustNot:\n    - { vendor: ga4, identity.hashesMatch: true }\n`)).toContain('only valid under must');
  expect(errorOf(`start: /\nexpect:\n  must:\n    - { vendor: ga4, before: consent, in: epoch(denied) }\n`)).toContain('either before or in');
  expect(errorOf(`start: /\nexpect:\n  must:\n    - { page: { matches: "(" } }\n`)).toContain('invalid regular expression');
  expect(errorOf(`start: /\nexpect:\n  must:\n    - { in: epoch(nope) }\n`)).toContain('epoch(undecided)');
  expect(errorOf(`start: /\nexpect:\n  must:\n    - { count: lots }\n`)).toContain('expect.must[0].count');
});

test('reports YAML syntax errors with a line', () => {
  expect(errorOf(`start: /\nsteps: [\n`)).toMatch(/^line \d+:/);
});

test('reports every problem at once', () => {
  const err = (() => {
    try {
      parseScenario(`start: /\nsteps:\n  - dance: 1\n  - wait: [x]\n`);
    } catch (e) {
      return e as ScenarioError;
    }
    throw new Error('expected error');
  })();
  expect(err.issues).toHaveLength(2);
});

test('boolean ids filters mean present and absent', () => {
  const s = parseScenario('start: /\nexpect:\n  mustNot:\n    - { vendor: ga4, ids.user_id: true, ids.client_id: false }');
  expect(s.expect.mustNot[0]!.filter.ids).toEqual({ user_id: 'present', client_id: 'absent' });
});

test('step labels: written, default, duplicate and checked by after', () => {
  const s = parseScenario('start: /\nsteps:\n  - visit: /cart\n    label: cart\n  - click: "#go"\n  - wait: "#x"\n');
  expect(s.steps.map((x) => x.label)).toEqual(['cart', 'click-2', 'wait-3']);
  expect(s.steps[2]).toMatchObject({ kind: 'wait', value: { selector: '#x' } });
  expect(parseScenario('start: /\nsteps:\n  - checkpoint: end\n').steps[0]!.label).toBe('end');
  expect(errorOf('start: /\nsteps:\n  - { visit: /a, label: x }\n  - { visit: /b, label: x }\n')).toContain('duplicate step label "x"');
  expect(errorOf('start: /\nsteps:\n  - visit: /\nexpect:\n  must:\n    - { vendor: ga4, after: nope }\n')).toMatch(/is not a step label.*visit-1/);
  expect(errorOf('start: /\nsteps:\n  - { visit: /a, label: start }\n')).toContain('duplicate step label "start"');
  expect(parseScenario('start: /\nexpect:\n  must:\n    - { vendor: ga4, after: start }\n').expect.must).toHaveLength(1);
  expect(parseScenario('start: /\nsteps:\n  - visit: /\nexpect:\n  must:\n    - { vendor: ga4, after: visit-1 }\n').expect.must).toHaveLength(1);
});
