import { trackerVendorKeys, vendorKeys } from '../../../packages/decoders/src/index.ts';

/** Vendors with a full decoder. */
export const decodedVendors: readonly string[] = vendorKeys;

/** Vendors from the built-in tracker list: stubbed and recorded, not decoded. */
export const stubbedVendors: readonly string[] = trackerVendorKeys;
