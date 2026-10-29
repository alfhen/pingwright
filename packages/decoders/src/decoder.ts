import { newId, type Hit, type Id, type Request } from '@pingwright/core';

export type NewHitId = () => Id<'hit'>;

export const defaultHitId: NewHitId = () => newId('hit');

export interface Decoder {
  name: string;
  /** `viaLoader` is true when `req` was unwrapped from a Stape custom loader URL. */
  match(req: Request, viaLoader?: boolean): boolean;
  /** One request can hold several hits. Hit ids come from `newHitId`. */
  decode(req: Request, newHitId?: NewHitId, viaLoader?: boolean): Hit[];
  /** True for requests that `stub` mode answers locally. */
  isCollectionEndpoint(req: Request, viaLoader?: boolean): boolean;
}
