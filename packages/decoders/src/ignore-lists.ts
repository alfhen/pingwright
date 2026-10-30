import { globToRegExp } from '@pingwright/core';

/** Transport fields every GA4 hit carries. A name may use `*` as a glob. */
export const GA4_BODY_ONLY_IGNORE: readonly string[] = [
  'v', 'tid', 'gtm', '_p', '_s', 'sid', 'sct', 'seg', 'dl', 'dr', 'dt', 'en', 'cid', 'ul', 'sr', '_eu', '_et',
  'gcs', 'gcd', 'npa', 'dma', 'dma_cps', 'are', 'frm', 'pscdl', 'tfd', 'ec',
  'uaa', 'uab', 'uafvl', 'uam', 'uamb', 'uap', 'uapv', 'uaw',
  '_ss', '_fv', '_nsi', '_c', '_ee', '_z', '_gaz', 'tag_exp', '_tu', 'ngs',
];

/** Transport fields every Meta pixel hit carries. A name may use `*` as a glob. */
export const META_BODY_ONLY_IGNORE: readonly string[] = [
  'id', 'ev', 'dl', 'rl', 'if', 'ts', 'sw', 'sh', 'v', 'r', 'ec', 'o', 'fbp', 'it', 'coo', 'rqm',
  'ler', 'cdl', 'plt', 'pmd[*]', 'expv2[*]', 'cs_est', 'a',
];

/** Transport fields every server-container data client hit carries. A name may use `*` as a glob. */
export const SGTM_BODY_ONLY_IGNORE: readonly string[] = ['v', 'tid', 'event', 'en', 'dtdc'];

export function matchesIgnoreList(name: string, list: readonly string[]): boolean {
  return list.some((entry) => globToRegExp(entry).test(name));
}
