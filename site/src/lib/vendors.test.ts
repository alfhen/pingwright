import { expect, test } from 'vitest';
import type { Request } from '../../../packages/core/src/index.ts';
import { decoders, decodeRequest, trackerList } from '../../../packages/decoders/src/index.ts';
import { decodedVendors, stubbedVendors } from './vendors.ts';

function req(url: string, method = 'GET', postData: string | null = null): Request {
  return {
    type: 'request',
    id: 'req_sample' as Request['id'],
    runId: 'run_sample' as Request['runId'],
    stepId: null,
    t: 1_800_000_000_000,
    method,
    url,
    resourceType: 'image',
    frameUrl: 'http://localhost:3000/',
    initiator: null,
    headers: {},
    postData,
    outcome: 'stubbed',
  };
}

const samples: Request[] = [
  req('https://www.google-analytics.com/g/collect?v=2&tid=G-PWTEST0001&cid=1.2&en=page_view'),
  req('https://www.googleadservices.com/pagead/conversion/000000001/?label=fake-label'),
  req('https://www.facebook.com/tr?id=100000000000001&ev=PageView'),
  req('https://ct.pinterest.com/v3/?tid=2612345678901&event=init'),
  req('https://shop.example.com/data?v=2&event=page_view'),
  req('https://graph.facebook.com/v19.0/100000000000001/events', 'POST', JSON.stringify({ data: [{ event_name: 'Purchase' }] })),
];

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

test('the samples exercise every direct decoder', () => {
  const matched = new Set(samples.flatMap((s) => decoders.filter((d) => d.match(s)).map((d) => d.name)));
  for (const d of decoders.filter((x) => x.name !== 'stape-custom-loader')) expect(matched, d.name).toContain(d.name);
});

test('the decoded vendors are the vendors the decoders give hits for', () => {
  const decoded = samples.flatMap((s) => decodeRequest(s, undefined, []).map((h) => h.vendor));
  expect(sorted(decodedVendors)).toEqual(sorted(decoded));
  expect(decodedVendors).toHaveLength(new Set(decodedVendors).size);
});

test('the stubbed vendors are the unique vendors of the tracker list', () => {
  expect(sorted(stubbedVendors)).toEqual(sorted(trackerList.map((e) => e.vendor)));
  expect(stubbedVendors).toHaveLength(new Set(stubbedVendors).size);
});
