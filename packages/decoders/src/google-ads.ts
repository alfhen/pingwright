import type { Hit, Request } from '@pingwright/core';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';
import { decodeGa4Consent } from './ga4.ts';

const ADS_HOSTS = ['googleadservices.com', 'doubleclick.net', 'google.com', 'googlesyndication.com'];

const PINGS = [
  /^\/pagead\/(?:viewthrough)?conversion\/(\w+)\/?$/,
  /^\/pagead\/1p-conversion\/(\w+)\/?$/,
  /^\/pagead\/1p-user-list\/(\w+)\/?$/,
  /^\/rmkt\/collect\/(\w+)(?:\/\w+)?\/?$/,
  /^\/ccm\/collect\/?$/,
];

const REMARKETING = /^\/(?:pagead\/(?:viewthroughconversion|1p-user-list)|rmkt\/collect)\//;

function hostMatches(host: string): boolean {
  return ADS_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

function pingPath(req: Request): { url: URL; id: string | undefined } | undefined {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return undefined;
  }
  if (!hostMatches(url.hostname)) return undefined;
  for (const re of PINGS) {
    const m = re.exec(url.pathname);
    if (m) return { url, id: m[1] };
  }
  return undefined;
}

const isAdsPing = (req: Request): boolean => pingPath(req) !== undefined;

export const googleAds: Decoder = {
  name: 'google-ads',
  match: isAdsPing,
  isCollectionEndpoint: isAdsPing,
  decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
    const ping = pingPath(req);
    if (!ping) return [];
    const p = new URLSearchParams(ping.url.search);
    if (req.method === 'POST' && req.postData) {
      for (const [k, v] of new URLSearchParams(req.postData)) p.set(k, v);
    }
    const ids: Hit['ids'] = {};
    for (const key of ['gclid', 'gbraid', 'wbraid']) if (p.get(key)) ids[key] = true;
    const params: Record<string, string> = {};
    const conversionId = ping.id ?? p.get('tid')?.replace(/^AW-/, '');
    if (conversionId) params.conversionId = conversionId;
    for (const [from, to] of [
      ['label', 'label'],
      ['value', 'value'],
      ['currency_code', 'currency'],
    ] as const) {
      const v = p.get(from);
      if (v) params[to] = v;
    }
    return [
      {
        type: 'hit',
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: 'google-ads',
        event: p.get('en') ?? (REMARKETING.test(ping.url.pathname) ? 'remarketing' : 'conversion'),
        consent: decodeGa4Consent(p),
        ids,
        page: p.get('url') ?? p.get('dl'),
        transport: req.resourceType === 'ping' ? 'beacon' : req.resourceType,
        params,
      },
    ];
  },
};
