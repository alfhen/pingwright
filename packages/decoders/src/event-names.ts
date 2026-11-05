/** Shopify standard event names and a few common aliases, mapped to the GA4 name a pixel normally sends. Not exhaustive. */
export const SHOPIFY_TO_GA4: Readonly<Record<string, string>> = {
  product_added_to_cart: 'add_to_cart',
  product_removed_from_cart: 'remove_from_cart',
  product_viewed: 'view_item',
  collection_viewed: 'view_item_list',
  cart_viewed: 'view_cart',
  checkout_started: 'begin_checkout',
  payment_info_submitted: 'add_payment_info',
  checkout_shipping_info_submitted: 'add_shipping_info',
  checkout_completed: 'purchase',
  search_submitted: 'search',
};

/** The GA4 name for a Shopify standard event name. Any other name is returned as it is. */
export function ga4EventName(name: string): string {
  return Object.hasOwn(SHOPIFY_TO_GA4, name) ? SHOPIFY_TO_GA4[name]! : name;
}
