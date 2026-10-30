# Shopify checkout pattern

A scenario shape for a Shopify store, from product page to purchase hits. It has eight steps. Payment is a `handoff`, because Pingwright never enters payment data on a hosted site (design §5.4). So this is a field-run pattern: a person must be at the machine.

Use a test store or a store with test payments on, a test card and a test account. Pingwright's fake identity uses example.com and fictional phone numbers.

1. Product: `start` on a product page.
2. Add to cart: `addToCart` clicks the button and checks that the cart changed (a `/cart/add` request or an `add_to_cart` event).
3. Checkout: `visit: /checkout`, labelled `checkout`.
4. Fill the identity: `fill` with fake identity names (`email`, `firstName`, ...).
5. Delivery country: set it explicitly. Shopify guesses the country from the machine's location.
6. Payment: a `handoff` step. The person enters the test card and submits.
7. Thank-you: a `wait` for the order page, labelled `thank-you`. Purchase hits fire when the order page loads, while the person is still in the handoff. A handoff step ends only when the person presses Enter, so a rule with `after: pay` would miss them. Anchor purchase rules on `after: checkout`, a step that ends before the handoff starts.
8. Hashes: `identity.hashesMatch` on the purchase hits.

Selectors differ per store and theme. Check them on your own checkout and adjust.

```yaml
start: /products/example-product
steps:
  - consent: accept
  - addToCart: "form[action$='/cart/add'] [type=submit]"
  - visit: /checkout
    label: checkout
  - fill:
      "#email": email
      "input[name=firstName]": firstName
      "input[name=lastName]": lastName
      "input[name=address1]": address1
      "input[name=city]": city
      "input[name=postalCode]": zip
      "input[name=phone]": phone
      "select[name=countryCode]": SE
  - handoff: "Enter the test card and pay, then wait for the order page."
    label: pay
  - wait: 10s
    label: thank-you
expect:
  must:
    - { vendor: ga4, event: purchase, after: checkout }
    - { vendor: meta, event: Purchase, identity.hashesMatch: true }
```

The YAML above is parsed by a unit test but never run against a store.

## Fixture variant

`e2e/scenarios/checkout-pattern.yml` runs the same shape against the fixture shop on loopback, where `fill` and a click on `#pay` are allowed. It uses `/checkout?pattern=1`: the fixture keeps the typed email in `sessionStorage`, and after `#pay` the thank-you page sends Meta `Purchase` with `ud[em]` set to the SHA-256 of that email. `checkout-pattern-wrong-hash.yml` types another email, so the hash does not match the run identity and the run fails. Plain `/thank-you` is unchanged.

Many stores send no hashed data to Meta from the browser. The hashes go to the server container's data client instead. `/checkout?pattern=sgtm` covers that: the thank-you page sends a `/data` hit through the mock Stape host with hashed `user_data` (email, phone, first name, last name, city). `checkout-sgtm.yml` checks it with `{ vendor: sgtm, event: purchase, identity.hashesMatch: true }`, fills a literal city and declares the phone under `identity`. `checkout-sgtm-wrong-hash.yml` types another email and fails.
