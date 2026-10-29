import type { Hit, Request } from '@pingwright/core';
import { decodeBase64Text } from './base64.ts';
import { defaultHitId, type Decoder, type NewHitId } from './decoder.ts';
import { decodeGa4Consent } from './ga4.ts';

function dataRequest(req: Request): URL | undefined {
  try {
    const url = new URL(req.url);
    return url.pathname === '/data' && url.searchParams.has('dtdc') ? url : undefined;
  } catch {
    return undefined;
  }
}

function parseDtdc(value: string | null): Record<string, unknown> {
  const text = value ? decodeBase64Text(value) : undefined;
  if (!text) return {};
  try {
    const json: unknown = JSON.parse(text);
    return json !== null && typeof json === 'object' && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export const sgtmDataClient: Decoder = {
  name: 'sgtm-data-client',
  match: (req) => dataRequest(req) !== undefined,
  isCollectionEndpoint: (req) => dataRequest(req) !== undefined,
  decode(req: Request, newHitId: NewHitId = defaultHitId): Hit[] {
    const url = dataRequest(req);
    if (!url) return [];
    const p = url.searchParams;
    const dtdc = parseDtdc(p.get('dtdc'));
    const ids: Hit['ids'] = {};
    if (p.get('cid')) ids.client_id = true;
    if (p.get('uid')) ids.user_id = true;
    const params: Record<string, string> = {};
    const tid = p.get('tid');
    if (tid) params.tid = tid;
    const hostname = str(dtdc.page_hostname);
    if (hostname) params.page_hostname = hostname;
    return [
      {
        type: 'hit',
        id: newHitId(),
        runId: req.runId,
        stepId: req.stepId,
        requestId: req.id,
        t: req.t,
        vendor: 'sgtm',
        event: p.get('en'),
        consent: decodeGa4Consent(p),
        ids,
        page: str(dtdc.page_location) ?? null,
        transport: req.resourceType === 'ping' ? 'beacon' : req.resourceType,
        params,
      },
    ];
  },
};
