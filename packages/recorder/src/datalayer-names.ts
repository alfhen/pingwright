import { isValueSegment, unwrapStapeLoader } from '@tagreeve/decoders';
import { newId, type Flag, type Id, type Request } from '@tagreeve/core';
import { DEFAULT_DATALAYER, isDataLayerName } from './datalayer.ts';

function loaderName(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!/\/(gtm\.js|gtag\/js)$/.test(parsed.pathname)) return undefined;
  const name = parsed.searchParams.get('l');
  return name === null || name === '' ? undefined : name;
}

/** The `l=` name of a Google loader request, read from the plain URL or from a Stape loader's decoded URL. */
export function loaderLayerName(req: Request): string | undefined {
  const direct = loaderName(req.url);
  if (direct !== undefined) return direct;
  const real = unwrapStapeLoader(req);
  return real ? loaderName(real.url) : undefined;
}

/** One flag when a loader names a layer that is not hooked. A name from a URL is never hooked. */
export function buildDataLayerNotHookedFlag(input: { runId: Id<'run'>; requests: readonly Request[]; hooked: readonly string[] }): Flag | undefined {
  const hooked = new Set([DEFAULT_DATALAYER, ...input.hooked]);
  const misses = input.requests.flatMap((req) => {
    const name = loaderLayerName(req);
    return name !== undefined && !hooked.has(name) ? [{ req, name }] : [];
  });
  const first = misses[0];
  if (!first) return undefined;
  const shown = isDataLayerName(first.name) && !isValueSegment(first.name) ? `"${first.name}"` : '(other)';
  return {
    type: 'flag',
    id: newId('flag'),
    runId: input.runId,
    kind: 'dataLayerNotHooked',
    recordIds: misses.map((m) => m.req.id),
    detail: `A Google loader names the data layer ${shown}, which is not hooked, so pushes to it are not recorded. Add it to options.dataLayerNames.`,
  };
}
