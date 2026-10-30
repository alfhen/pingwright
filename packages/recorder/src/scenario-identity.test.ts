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

test('declared fields replace generated ones and literal fill values become extra', () => {
  const identity = scenarioIdentity(parseScenario(yaml), 1);
  const generated = createIdentity(1);
  expect(identity.phone).toBe('+46701740620');
  expect(identity.email).toBe(generated.email);
  expect(identity.extra).toEqual(['Berlin']);
});

test('a scenario without literals or declared fields gives the plain identity', () => {
  const identity = scenarioIdentity(parseScenario('start: /\nsteps:\n  - fill: { "#email": email }\n'), 1);
  expect(identity).toEqual(createIdentity(1));
});
