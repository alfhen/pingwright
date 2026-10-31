import { trackerVendorKeys, vendorKeys } from '@pingwright/decoders';
import { expect, test } from 'vitest';
import { byVendorName, vendorLabel, vendorName, VENDOR_NAMES } from './names.ts';

test('every decoder and tracker list vendor key has a plain name', () => {
  for (const key of [...vendorKeys, ...trackerVendorKeys]) expect(VENDOR_NAMES[key], key).toBeTruthy();
});

test('a key with no entry prints as the key', () => {
  expect(vendorName('acme-pixel')).toBe('acme-pixel');
  expect(vendorLabel('acme-pixel')).toBe('acme-pixel');
  expect(vendorName('constructor')).toBe('constructor');
});

test('a label is the name with the key in brackets, and lists sort by name', () => {
  expect(vendorLabel('sgtm')).toBe('server container (sgtm)');
  expect(['sgtm', 'meta', 'ga4', 'acme'].sort(byVendorName)).toEqual(['acme', 'ga4', 'meta', 'sgtm']);
});
