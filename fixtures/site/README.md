# Fixture site

A fake shop for Pingwright tests. It is the private workspace package `@pingwright/fixture-site`. Nothing here is real: all IDs, names and card numbers are fake.

```ts
import { startFixtureSite } from '@pingwright/fixture-site';
const { url, sgtmUrl, thirdPartyUrl, close } = await startFixtureSite();
```

For manual use, run `pnpm fixture` in the repo root. It prints the URLs.

Opened in a normal browser, the shop sends live GA4, Google Ads, remarketing, Consent Mode and Meta `/tr` hits to Google and Meta, with fake IDs but real page URLs and client IDs. Block them first. The sandboxed pixel's POST to `https://collector.pingwright.invalid/` fails there, because only Pingwright or a `context.route` answers that origin.

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
| `#card-number` (`cc-number`), `#card-expiry` (`cc-exp`), `#card-cvc` (`cc-csc`), `#pay` | `/checkout/payment` | Fake card form. `#pay` goes to `/thank-you`, or to `/thank-you?pattern=1` when the flag below is set. |

Pattern variant: `/checkout?pattern=1` sets the `pw_pattern` flag in `sessionStorage` when the identity form is submitted. Every identity-form submit, with or without the flag, stores the typed fields in `pw_checkout`. With the flag, `#pay` goes to `/thank-you?pattern=1`, where Meta `Purchase` carries `ud[em]`, the SHA-256 of the typed email (trimmed, lower case). Plain `/checkout` and `/thank-you` are unchanged. The scenario shape is in [docs/shopify-checkout.md](../../docs/shopify-checkout.md).

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

## Fake GTM containers

A fourth server, `containerUrl` (`http://127.0.0.1:<p4>`), answers `/gtm.js?id=GTM-PWTEST1` with a small local script. It is not real GTM. Tests route `https://www.googletagmanager.com/gtm.js` to it with `context.route`. Nothing is hosted by Pingwright.

| Request | Answer |
| --- | --- |
| `id=GTM-PWTEST1` | The `published` build. |
| `id=GTM-PWTEST1&gtm_auth=pwfake-auth-0001&gtm_preview=env-99&gtm_cookies_win=x` | The `workspace` build. |
| `id=GTM-PWTEST1` plus `build=workspace` without the full fake set, or any partial or wrong set | 404. |
| `id=GTM-PWNOVER` (a container with no version), or any other id | 404. |

The fake values are exported as `fakeWorkspace` from `src/containers.ts`. The site's `receivedGtmAuth` lists every `gtm_auth` value the container host or the Stape-style host received, for a positive control.

Differences between the builds, seen on the pages below:

| | published | workspace |
| --- | --- | --- |
| Consent Mode default | all four signals `denied` | `ad_storage` `granted`, the other three `denied` |
| Undecided GA4 `page_view` `gcs` | `G100` | `G110` |
| GA4 events | `page_view`, `container_event` | also `workspace_only` |
| Meta events | `PageView`, `ViewContent`, `AddToCart` | no `AddToCart` |
| Echoes `gtm_auth` | no | yes, on every container page except `/container/direct`: in an image URL and a beacon body to `thirdPartyUrl` (`/gtm-echo.gif`, `/gtm-echo`), as `Referer` of `/gtm-referer.gif`, sent by a hidden iframe at `/container/echo-frame?gtm_auth=...` that the build adds, and in a Stape-style `/g/collect` (`dl`) and `/data` (`dtdc` `page_location`) pair to `sgtmUrl`, base64 inside base64 |

The container sets the Consent Mode default itself and the pages never decide consent, so every container page is undecided. The `gcs` values come from the real gtag.js, and the e2e asserts both.

Pages (they load no shop scripts, and they load the real gtag.js and fbevents.js from the internet, so stub the collection paths):

- `/container/direct`: `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1">`.
- `/container/echo`: the same. Its URL is clean; the workspace build adds `/container/echo-frame?gtm_auth=...` (an `unsafe-url` referrer policy) as a hidden iframe.
- `/container/noversion`: loads `GTM-PWNOVER`, which is 404. The page still runs.
- `/container/stape`: loads the container as `sgtmUrl/pwstape?pk=<base64 of /gtm.js?id=GTM-PWTEST1>`.
- `/container/stape-script`: loads the container as a Stape custom loader script, `sgtmUrl/pwload-a1b2c3.js?k=<reversed path>`. The path is the reversed string `/gtm.js?id=GTM-PWTEST1`, not base64.
- `/container/redirect-script`: loads `sgtmUrl/pwredir-d4e5f6.js?k=x`, which answers 302 to `sgtmUrl/g/collect` (a GA4 hit). It is not a container.
- `/container/sandbox-script`: the same loader script inside a sandboxed iframe (`/web-pixels@0.0.0-fixture/sandbox/container-script/`).
- `/container/sandbox`: a sandboxed iframe (`/web-pixels@0.0.0-fixture/sandbox/container/`) with the same Stape-style loader. Real gtag.js cannot run in an opaque-origin frame, so the frame sends the same GA4 and Meta events itself, as a custom pixel does. Its GA4 `dl` is the sandbox URL.

## Pinterest page

`/pinterest` loads the standard Pinterest tag snippet and the real `s.pinimg.com/ct/core.js` (needs internet access). Tag ID `2612345678901`, fake email `pinterest-fixture@example.com`. On load, with no consent step, it fires `init`, `pagevisit`, `addtocart` and `checkout` to `ct.pinterest.com`. Stub collection paths so no hit leaves the machine. The page has no banner, on purpose.

## Tracker page

`/tracker` needs no internet access. It loads `thirdPartyUrl/i18n/pixel/events.js` (script), POSTs `thirdPartyUrl/api/v2/pixel?event=Purchase&url=...` (a TikTok-style pixel), and loads `http://criteo.localhost:<p3>/m/collect?event=viewItem&callback=pwCriteo` as a script (a Criteo-style JSONP collection). Neither host is in the built-in list. Tests list host `127.0.0.1` for tiktok and `criteo.localhost` with path `/m/collect` for criteo in a `--tracker-list` file.

## Stable IDs page

`/stable-ids` loads the shop banner and, after 1.5 s and again after 2.5 s, POSTs one fake SHA-256 client ID under `clientIdHash`, `client_id_hash`, `external_id`, `uid`, `user_id`, `id` and `uuid` to `thirdPartyUrl/stable-ids/data`, and loads `thirdPartyUrl/stable-ids/session?hmac=<hex>&id=<same hash>`. With `?leak=email` it also POSTs the hash of `other.person@example.com` as `external_id` once.

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

## Delayed hit page

`/delayed-hit` needs no internet access. It sends one GA4 `page_view` image hit to `www.google-analytics.com` after `?delay=<ms>` (default 1500), with `?gcs=<value>` (default `G100`). Stub the collection path so no hit leaves the machine. Scenarios use it to land the same hit in different steps.
