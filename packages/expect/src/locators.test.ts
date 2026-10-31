import { expect, test } from 'vitest';
import { parseScenario } from './scenario.ts';

const steps = (yaml: string) => parseScenario(`start: /\nsteps:\n${yaml}`).steps;
const issue = (yaml: string): string => {
  try {
    steps(yaml);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected an error');
};

test('click and wait take a selector string, a role and name, or an any list', () => {
  const parsed = steps(`  - click: "#a"
  - click: { role: radio, name: "White (01)" }
  - click: { role: radio, name: "White (01)", exact: true }
  - click: { role: button }
  - click: { any: ['[role=radio]', 'text=White (01)'] }
  - wait: { role: tab, name: Details }
  - wait: { any: ['#a', '#b'] }
  - wait: "#c"
`);
  expect(parsed.map((s) => s.value)).toEqual([
    '#a',
    { role: 'radio', name: 'White (01)' },
    { role: 'radio', name: 'White (01)', exact: true },
    { role: 'button' },
    { any: ['[role=radio]', 'text=White (01)'] },
    { selector: { role: 'tab', name: 'Details' } },
    { selector: { any: ['#a', '#b'] } },
    { selector: '#c' },
  ]);
});

test('an invalid locator object is an error that names the step', () => {
  expect(issue('  - click: { any: [] }\n')).toContain('steps[0].click.any');
  expect(issue("  - click: { any: ['#a', ''] }\n")).toContain('steps[0].click.any');
  expect(issue("  - click: { any: ['#a'], role: radio }\n")).toContain('any cannot be combined');
  expect(issue('  - click: { name: x }\n')).toContain('steps[0].click.role');
  expect(issue('  - click: { role: "Radio Button" }\n')).toContain('steps[0].click.role');
  expect(issue('  - click: { role: radio, name: "" }\n')).toContain('steps[0].click.name');
  expect(issue('  - click: { role: radio, name: x, exact: yes }\n')).toContain('steps[0].click.exact');
  expect(issue('  - click: { role: radio, exact: true }\n')).toContain('needs a name');
  expect(issue('  - click: { role: radio, text: x }\n')).toContain('steps[0].click.text');
  expect(issue('  - click: {}\n')).toContain('steps[0].click');
  expect(issue('  - wait: { any: [] }\n')).toContain('steps[0].wait.any');
});

test('select takes a selector to option mapping and keeps its label', () => {
  const [step] = steps('  - select: { "select[name=countryCode]": DE }\n    label: pick\n');
  expect(step).toMatchObject({ kind: 'select', value: { 'select[name=countryCode]': 'DE' }, label: 'pick' });
  expect(steps('  - select: { "#size": "42" }\n')[0]).toMatchObject({ value: { '#size': '42' } });
  expect(issue('  - select: { "#size": 01 }\n')).toContain('quote it');
  expect(issue('  - select: "#a"\n')).toContain('steps[0].select');
  expect(issue('  - select: {}\n')).toContain('steps[0].select');
  expect(issue('  - select: { "#a": "" }\n')).toContain('steps[0].select');
});
