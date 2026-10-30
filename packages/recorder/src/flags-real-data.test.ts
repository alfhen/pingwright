import { createIdentity, hashEmail, newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { buildFlags } from './flags.ts';
import { REDACTED, Scrubber } from './gtm-scrub.ts';

const secret = 'pwfake-auth-0001';
const identity = createIdentity(1);

function req(url: string, over: Partial<Request> = {}): Request {
  return {
    type: 'request', id: newId('request'), runId: newId('run'), stepId: null, t: 1, method: 'GET', url,
    resourceType: 'fetch', frameUrl: null, initiator: null, headers: {}, postData: null, outcome: 'stubbed', ...over,
  };
}

const flagsFor = (requests: Request[]) =>
  buildFlags({
    runId: newId('run'), networkMode: 'stub', siteUrl: 'http://localhost:3000', requests, hits: [], identity, routedRequestIds: new Set(),
  });

test('the scan sees a value that the scrub later redacts whole, and the stored flag holds no secret', () => {
  const foreign = hashEmail('other@example.com').hex;
  const packed = Buffer.from(`gtm_auth=${secret}&em=${foreign}`).toString('base64');
  const url = `https://tracker.example.net/c?x=${encodeURIComponent(packed)}`;
  const flags = flagsFor([req(url)]);
  const real = flags.filter((f) => f.kind === 'possibleRealData');
  expect(real).toHaveLength(1);

  const stored = JSON.stringify(new Scrubber(secret).deep(flags));
  expect(stored).toContain('possibleRealData');
  expect(stored).not.toContain(secret);
  expect(stored).not.toContain(foreign);
  expect(new Scrubber(secret).url(url)).toBe(`https://tracker.example.net/c?x=${REDACTED}`);
});

test('no identity means no possibleRealData flags, and the identity own values are not flagged', () => {
  const own = req(`https://tracker.example.net/c?em=${hashEmail(identity.email).hex}`);
  expect(flagsFor([own]).filter((f) => f.kind === 'possibleRealData')).toEqual([]);
  const foreign = req(`https://tracker.example.net/c?em=${hashEmail('other@example.com').hex}`);
  const without = buildFlags({ runId: newId('run'), networkMode: 'stub', siteUrl: 'http://localhost:3000', requests: [foreign], hits: [], routedRequestIds: new Set() });
  expect(without.filter((f) => f.kind === 'possibleRealData')).toEqual([]);
});
