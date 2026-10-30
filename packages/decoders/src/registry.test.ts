import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decoders, decodeRequest, vendorKeys } from './index.ts';

function req(url: string, over: Partial<Request> = {}): Request {
  return {
    type: 'request',
    id: newId('request'),
    runId: newId('run'),
    stepId: null,
    t: 1_800_000_000_000,
    method: 'GET',
    url,
    resourceType: 'image',
    frameUrl: 'http://localhost:3000/',
    initiator: null,
    headers: {},
    postData: null,
    outcome: 'stubbed',
    ...over,
  };
}

const samples: Request[] = [
  req('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=page_view'),
  req('https://www.googleadservices.com/pagead/conversion/000000001/?label=fake-label'),
  req('https://www.facebook.com/tr?id=100000000000001&ev=PageView'),
  req('https://ct.pinterest.com/v3/?tid=2612345678901&event=init'),
  req('https://shop.example.com/data?v=2&event=page_view'),
];

test('every sample request decodes to a vendor listed in vendorKeys', () => {
  const vendors = new Set(samples.flatMap((s) => decodeRequest(s).map((h) => h.vendor)));
  expect([...vendors].sort()).toEqual([...vendorKeys].sort());
});

test('every direct decoder is exercised by a sample', () => {
  const matched = samples.flatMap((s) => decoders.filter((d) => d.match(s)).map((d) => d.name));
  for (const d of decoders.filter((x) => x.name !== 'stape-custom-loader')) expect(matched).toContain(d.name);
});
