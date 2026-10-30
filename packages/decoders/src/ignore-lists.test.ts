import { newId, type Request } from '@pingwright/core';
import { expect, test } from 'vitest';
import { decodeRequest, GA4_BODY_ONLY_IGNORE, matchesIgnoreList, META_BODY_ONLY_IGNORE, SGTM_BODY_ONLY_IGNORE } from './index.ts';

const GTAG_QUERY = [
  'v=2', 'tid=G-PWTEST0001', 'gtm=45je5aa0v9100000za200', '_p=1760000000000', 'gcd=13l3l3l3l1l1', 'npa=0', 'dma=0',
  'tag_exp=101509157~103116026', 'cid=1111111111.2222222222', 'ul=en-us', 'sr=1280x720', 'uaa=x86', 'uab=64',
  'uafvl=Chromium%3B156.0.0.0', 'uamb=0', 'uam=1', 'uap=macOS', 'uapv=15.0.0', 'uaw=0', 'are=1', 'frm=0',
  'pscdl=noapi', '_eu=EBAI', '_s=1', 'sid=1760000000', 'sct=1', 'seg=1',
  'dl=http%3A%2F%2Flocalhost%3A3000%2F', 'dr=http%3A%2F%2Flocalhost%3A3000%2Fa', 'dt=Fake', 'en=page_view', '_fv=1',
  '_nsi=1', '_ss=1', '_ee=1', '_c=1', '_z=fetch', '_gaz=1', '_tu=BA', 'ngs=1', 'dma_cps=sypham', 'gcs=G100',
].join('&');

const request: Request = {
  type: 'request',
  id: newId('request'),
  runId: newId('run'),
  stepId: null,
  t: 1_800_000_000_000,
  method: 'GET',
  url: `https://region1.google-analytics.com/g/collect?${GTAG_QUERY}`,
  resourceType: 'image',
  frameUrl: 'http://localhost:3000/products/fake-tee',
  initiator: null,
  headers: {},
  postData: null,
  outcome: 'stubbed',
};

test('a realistic gtag.js hit has only fields on the GA4 body.only ignore list', () => {
  const [hit] = decodeRequest(request);
  expect(hit?.fields?.length).toBeGreaterThan(30);
  expect((hit?.fields ?? []).filter((f) => !matchesIgnoreList(f, GA4_BODY_ONLY_IGNORE))).toEqual([]);
  expect(matchesIgnoreList('email', GA4_BODY_ONLY_IGNORE)).toBe(false);
});

test('ignore list entries may be globs', () => {
  expect(matchesIgnoreList('pmd[ab]', META_BODY_ONLY_IGNORE)).toBe(true);
  expect(matchesIgnoreList('expv2[0]', META_BODY_ONLY_IGNORE)).toBe(true);
  expect(matchesIgnoreList('email', META_BODY_ONLY_IGNORE)).toBe(false);
  expect(SGTM_BODY_ONLY_IGNORE).toContain('dtdc');
});
