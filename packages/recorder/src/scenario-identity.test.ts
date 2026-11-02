import { createIdentity } from '@pingwright/core';
import { parseScenario } from '@pingwright/expect';
import { expect, test } from 'vitest';
import { scenarioIdentity } from './steps.ts';

const yaml = `start: /
identity:
  phone: "+46701740620"
steps:
  - fill:
      "#email": email
      "#city": Berlin
      "#card-number": "4242424242424242"
      "#note": Berlin
`;

test('declared fields replace generated ones and literal fill values are not extra up front', () => {
  const identity = scenarioIdentity(parseScenario(yaml), 1);
  const generated = createIdentity(1);
  expect(identity.phone).toBe('+46701740620');
  expect(identity.email).toBe(generated.email);
  expect(identity.extra).toBeUndefined();
});

test('a scenario without literals or declared fields gives the plain identity', () => {
  const identity = scenarioIdentity(parseScenario('start: /\nsteps:\n  - fill: { "#email": email }\n'), 1);
  expect(identity).toEqual(createIdentity(1));
});

test('identity.country picks the local format and is upper-cased', () => {
  const se = scenarioIdentity(parseScenario('start: /\nidentity: { country: se }\n'), 1);
  expect(se.country).toBe('SE');
  expect(se.phone).toMatch(/^\+4670174/);
  expect(se).toEqual(createIdentity(1, { country: 'SE' }));
  expect(scenarioIdentity(parseScenario('start: /\nidentity: { country: GB }\n'), 1).phone).toMatch(/^\+447700900/);
});

test('a country with no format keeps US-shaped data under its label', () => {
  const dk = scenarioIdentity(parseScenario('start: /\nidentity: { country: DK }\n'), 1);
  expect(dk.country).toBe('DK');
  expect(dk.phone).toMatch(/^\+1/);
});
