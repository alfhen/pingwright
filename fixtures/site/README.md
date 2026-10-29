# Fixture site

A fake shop for Pingwright tests. It is the private workspace package `@pingwright/fixture-site`. Nothing here is real: all IDs, names and card numbers are fake.

```ts
import { startFixtureSite } from '@pingwright/fixture-site';
const { url, sgtmUrl, thirdPartyUrl, close } = await startFixtureSite();
```

For manual use, run `pnpm fixture` in the repo root. It prints the three URLs.

## Servers

All three listen on port 0 (random).

| Name | URL | Role |
| --- | --- | --- |
| `url` | `http://localhost:<p1>` | The shop. |
| `sgtmUrl` | `http://127.0.0.1:<p2>` | Mock server-container host. `/pwstape?pk=<base64 path>`: 200 with a tiny script when the decoded path starts with `/gtag/js`, 204 otherwise. |
| `thirdPartyUrl` | `http://127.0.0.1:<p3>` | Unknown third-party host. Answers every path with a 1x1 GIF. |

`localhost` and `127.0.0.1` are different sites, so requests to the last two are cross-site.

## Pages

`/`, `/products/fake-tee`, `/collections/all`, `/cart`, `/checkout`, `/checkout/payment`, `/thank-you`. Every page loads `/fixture-config.js` and `/assets/site.js`.

## Element IDs

| ID | Where | Notes |
| --- | --- | --- |
| `#pw-consent-banner` | every page | Hidden once a choice is stored. |
| `#pw-accept`, `#pw-reject` | banner | Store `pw_consent` and send a Consent Mode update. |
| `#pw-cookie-settings` | footer link, every page | Reopens the banner. Rejecting then sends an update to denied. |
| `#pw-web-pixel` | every page | The sandboxed iframe. |
| `#add-to-cart` | `/products/fake-tee` | Pushes the item to the cart in `localStorage` (`pw_cart`). |
| `#cart-count`, `#checkout-link` | `/cart` | |
| `#email`, `#first-name`, `#last-name`, `#phone`, `#address1`, `#city`, `#zip` | `/checkout` | Identity form. |
| `#country` | `/checkout` | Options US, GB, DE, SE, NO. The default is guessed from the region of `navigator.language`, so scenarios must set it explicitly. |
| `#continue` | `/checkout` | Goes to `/checkout/payment`. |
| `#card-number` (`cc-number`), `#card-expiry` (`cc-exp`), `#card-cvc` (`cc-csc`), `#pay` | `/checkout/payment` | Fake card form. `#pay` goes to `/thank-you`. |

## Consent

The choice is stored in the first-party cookie `pw_consent` (`accept` or `reject`). Before any tag, the page calls `gtag('consent','default', ...)` with all four signals denied and `wait_for_update: 500`. A choice sends `gtag('consent','update', ...)`.

## Requests

- `gtag.js` for `G-PWTEST0001` from googletagmanager.com, with `config` for `G-PWTEST0001` and `AW-000000001`. Needs internet access.
- Meta `fbevents.js` from connect.facebook.net, `fbq('init', '100000000000001')` and `PageView`. Needs internet access.
- `/products/fake-tee`: GA4 `view_item`. `#add-to-cart`: GA4 `add_to_cart`, Meta `AddToCart`.
- `/checkout`: GA4 `begin_checkout` on continue.
- `/thank-you`: GA4 `purchase` (`transaction_id` `fixture-order-0001`), Meta `Purchase`, Google Ads conversion `send_to` `AW-000000001/fake-label`.
- Mock Stape loader, on every page, to `sgtmUrl`: `/pwstape?pk=<base64 of '/gtag/js?id=G-PWTEST0001'>` (script), `/pwstape?pk=<base64 of '/g/collect?v=2&tid=G-PWTEST0001&cid=...&en=page_view&dl=...'>`, and `/pwstape?pk=<base64 of '/data?v=2&tid=...&dtdc=<base64 JSON>'>`. The `dtdc` JSON has `page_location` and `page_hostname`.
- Unknown destination: an image from every page to `thirdPartyUrl/unknown-pixel?x=1`.
- Sandboxed iframe at `/web-pixels@0.0.0-fixture/sandbox/modern/` (`sandbox="allow-scripts allow-forms"`): POSTs JSON `{source:'fixture-pixel', event:'page_viewed', href}` to `https://collector.pingwright.invalid/report`, and POSTs a GA4-style hit to `https://region1.google-analytics.com/g/collect` with `dl` set to its own sandbox URL. Both use `mode: 'no-cors'` and a simple content type, because an opaque-origin frame cannot pass a CORS preflight. The collector origin does not resolve, so a test must answer it with `context.route`.

## Deliberate defects

- Reproduces a real failure: when `navigator.userAgent` contains `HeadlessChrome`, the banner grants consent itself, stores `accept` and never shows.
- GA4 `purchase` sets `user_id` `fixture-user-0001` whatever the consent state.
- The sandboxed pixel sends its sandbox URL as the GA4 page URL (`dl`).
- The delivery country default depends on the browser language.
- An unknown third-party destination is contacted on every page.

## Notes for tests

- The Meta pixel ID is `100000000000001`, not `000000000000001`. fbevents.js rejects IDs that start with 0 ("Invalid PixelID"), and then sends no `/tr` request. With this ID, `/tr` requests fire.
- GA4 sends `page_view` at once but other events (`add_to_cart`, `purchase`) several seconds later, and drops them if the page navigates away first. Wait for them before navigating.
- Real tags load from Google and Meta, so e2e runs need internet access. Stub collection paths with `context.route` so no hit leaves the machine.
