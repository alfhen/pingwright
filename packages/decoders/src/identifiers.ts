import { globToRegExp, type ConsentState, type ConsentValue } from '@pingwright/core';

export type IdentifierClass = 'analytics' | 'adsIdentity' | 'clientIdHash';

export const ANALYTICS_ID_NAMES: readonly string[] = ['user_id', 'uid', 'up.user_id'];

export const ADS_IDENTITY_NAMES: readonly string[] = [
  'external_id',
  'ud',
  'ud[*]',
  'user_data',
  'user_data.*',
  'em',
  'ph',
  'hashed_email',
  'customer_hashed',
  'cookieData',
];

export const CLIENT_ID_HASH_NAMES: readonly string[] = ['clientIdHash', 'client_id_hash', 'cid_hash'];

const CLASSES: readonly { cls: IdentifierClass; patterns: RegExp[] }[] = [
  { cls: 'analytics', patterns: ANALYTICS_ID_NAMES.map(globToRegExp) },
  { cls: 'adsIdentity', patterns: ADS_IDENTITY_NAMES.map(globToRegExp) },
  { cls: 'clientIdHash', patterns: CLIENT_ID_HASH_NAMES.map(globToRegExp) },
];

const HEX_64 = /^[0-9a-f]{64}$/i;

/** The class of a listed identifier name, or undefined when the name is not on a list. */
export function listedIdentifierClass(name: string): IdentifierClass | undefined {
  return CLASSES.find((c) => c.patterns.some((re) => re.test(name)))?.cls;
}

/** A name on a list, or a field whose value is 64 hex characters under any name. The value is not kept. */
export function isIdentifierField(name: string, value: string): boolean {
  return listedIdentifierClass(name) !== undefined || HEX_64.test(value);
}

/** Names that are not listed (a 64-hex value under a neutral name) count as analytics identifiers. */
export function identifierClass(name: string): IdentifierClass {
  return listedIdentifierClass(name) ?? 'analytics';
}

/** The consent signal that must not be denied for this class. The Ads class falls back to `ads` when `adUserData` is unknown. */
export function identifierSignal(cls: IdentifierClass, state: ConsentState): { field: 'analytics' | 'ads' | 'adUserData'; value: ConsentValue } {
  if (cls !== 'adsIdentity') return { field: 'analytics', value: state.analytics };
  return state.adUserData !== 'unknown' ? { field: 'adUserData', value: state.adUserData } : { field: 'ads', value: state.ads };
}
