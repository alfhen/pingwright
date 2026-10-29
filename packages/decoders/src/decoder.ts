import { newId, type Hit, type Id, type Request } from '@pingwright/core';

export type NewHitId = () => Id<'hit'>;

export const defaultHitId: NewHitId = () => newId('hit');

export interface Decoder {
  name: string;
  match(req: Request): boolean;
  /** One request can hold several hits. Hit ids come from `newHitId`. */
  decode(req: Request, newHitId?: NewHitId): Hit[];
  /** True for requests that `stub` mode answers locally. */
  isCollectionEndpoint(req: Request): boolean;
}
