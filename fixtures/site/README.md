# Fixture site

A fake shop for Pingwright tests. It is the private workspace package `@pingwright/fixture-site`. Nothing here is real: all IDs, names and card numbers are fake.

```ts
import { startFixtureSite } from '@pingwright/fixture-site';
const { url, sgtmUrl, thirdPartyUrl, close } = await startFixtureSite();
```

For manual use, run `pnpm fixture` in the repo root. It prints the URLs.

Opened in a normal browser, the shop sends live GA4, Google Ads, remarketing, Consent Mode and Meta `/tr` hits to Google and Meta, with fake IDs but real page URLs and client IDs. Block them first. The sandboxed pixel's POST to `https://collector.pingwright.invalid/` fails there, because only Pingwright or a `context.route` answers that origin.

## Servers

All servers listen on port 0 (random).

| Name | URL | Role |
| --- | --- | --- |
| `url` | `http://localhost:<p1>` | The shop. |
| `sgtmUrl` | `http://127.0.0.1:<p2>` | Mock server-container host. `/pwstape?pk=<base64 path>`: 200 with a tiny script when the decoded path starts with `/gtag/js`, 204 otherwise. |
| `thirdPartyUrl` | `http://127.0.0.1:<p3>` | Unknown third-party host. Answers every path with a 1x1 GIF. |
| `paymentFrameUrl` | `http://127.0.0.1:<p5>` | Card frame host for `/checkout/test-payment`. Answers only `GET /card-frame` and `POST /card-submit`. Each submit adds the posted card number (a test card value) to `cardSubmits`. |

`localhost` and `127.0.0.1` are different sites, so requests to every 127.0.0.1 server are cross-site.

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

Pattern variant: `/checkout?pattern=1` sets the `pw_pattern` flag in `sessionStorage` when the identity form is submitted. Every identity-form submit, with or without the flag, stores the typed fields in `pw_checkout`. With the flag, `#pay` goes to `/thank-you?pattern=1`, where Meta `Purchase` carries `ud[em]`, the SHA-256 of the typed email (trimmed, lower case). `/checkout?pattern=sgtm` sets the flag to `sgtm`. Then `#pay` goes to `/thank-you?pattern=sgtm`, where Meta `Purchase` carries no hashed data and a server-container `/data` hit (through the mock Stape host) carries a `dtdc` payload with `event_name` `purchase` and `user_data` hashes of the typed email, phone (E.164), first name, last name and city. Plain `/checkout` and `/thank-you` are unchanged. The scenario shape is in [docs/shopify-checkout.md](../../docs/shopify-checkout.md).

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
- Sandboxed iframe at `/web-pixels@0.0.0-fixture/sandbox/modern/` (the hash comes from the page's `?pixel=<hash>` query and defaults to `0.0.0-fixture`; the server answers any `/web-pixels@<hash>/sandbox/modern/` path, so a test can change the hash between two runs) (`sandbox="allow-scripts allow-forms"`): POSTs JSON `{source:'fixture-pixel', event:'page_viewed', href}` to `https://collector.pingwright.invalid/report`, and POSTs a GA4-style hit to `https://region1.google-analytics.com/g/collect` with `dl` set to its own sandbox URL. Both use `mode: 'no-cors'` and a simple content type, because an opaque-origin frame cannot pass a CORS preflight. The collector origin does not resolve, so a test must answer it with `context.route`.

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
| GA4 events | `page_view`, `container_event` | also `workspace_only`, and `ws_echo` (sent through `sgtmUrl` on every container page except `/container/direct`) |
| Meta events | `PageView`, `ViewContent`, `AddToCart` | no `AddToCart` |
| Echoes `gtm_auth` | no | yes, on every container page except `/container/direct`: in an image URL and a beacon body to `thirdPartyUrl` (`/gtm-echo.gif`, `/gtm-echo`), as `Referer` of `/gtm-referer.gif`, sent by a hidden iframe at `/container/echo-frame?gtm_auth=...` that the build adds, and in a Stape-style `/g/collect` (`dl`) and `/data` (`dtdc` `page_location`) pair to `sgtmUrl`, base64 inside base64 |

The container sets the Consent Mode default itself and the pages never decide consent, so every container page is undecided. The `gcs` values come from the real gtag.js, and the e2e asserts both.

Pages (they load no shop scripts, and they load the real gtag.js and fbevents.js from the internet, so stub the collection paths):

- `/container/direct`: `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1">`.
- `/container/echo`: the same. Its URL is clean; the workspace build adds `/container/echo-frame?gtm_auth=...` (an `unsafe-url` referrer policy) as a hidden iframe.
- `/container/echo-frame`: the hidden iframe that the workspace build adds. Not a page to open by hand.
- `/container/noversion`: loads `GTM-PWNOVER`, which is 404. The page still runs.
- `/container/stape`: loads the container as `sgtmUrl/pwstape?pk=<base64 of /gtm.js?id=GTM-PWTEST1>`.
- `/container/stape-script`: loads the container as a Stape custom loader script, `sgtmUrl/pwload-a1b2c3.js?k=<reversed path>`. The path is the reversed string `/gtm.js?id=GTM-PWTEST1`, not base64.
- `/container/redirect-script`: loads `sgtmUrl/pwredir-d4e5f6.js?k=x`, which answers 302 to `sgtmUrl/g/collect` (a GA4 hit). It is not a container.
- `/container/sandbox-script`: the same loader script inside a sandboxed iframe (`/web-pixels@0.0.0-fixture/sandbox/container-script/`).
- `/container/sandbox`: a sandboxed iframe (`/web-pixels@0.0.0-fixture/sandbox/container/`) with the same Stape-style loader. Real gtag.js cannot run in an opaque-origin frame, so the frame sends the same GA4 and Meta events itself, as a custom pixel does. Its GA4 `dl` is the sandbox URL.

## Unload beacons page

`/unload-beacons` has the banner and a sandboxed iframe (`sandbox="allow-scripts"`, `/web-pixels@0.0.0-fixture/sandbox/unload/`) that, like GA4 for a visitor who has not consented, holds an `add_to_cart` hit and flushes it in `pagehide`, as one `navigator.sendBeacon` and one `fetch` with `keepalive`, to `https://sgtm.pingwright.invalid/g/collect` (`ep.via=beacon` or `keepalive`, `gcs=G100`). The host does not resolve, so nothing leaves the machine even when stub mode does not catch the requests. `#add-to-cart` tells the frame to hold the hit. The page also loads `site.js`, so it has the usual banner, gtag and modern pixel. `/unload-beacons-bare` is the same page without `site.js`: no banner and no third-party tags, so live-mode tests send nothing off the machine.

## Unload Request body page

`/unload-request-body` has no banner and no tags. In `pagehide` it sends `fetch(new Request(url, { method: 'POST', body, keepalive: true }))` to `https://sgtm.pingwright.invalid/g/collect`. The body holds two GA4 events, `add_to_cart` and `view_item`, one per line.

## Unload gap page

`/unload-gap` has the banner and a sandboxed iframe (`/web-pixels@0.0.0-fixture/sandbox/gap/`). 1.8 s after it loads, the frame pushes `{event: 'consent_update'}` (no hit) and `{event: 'item_added'}`, and sends a `/data` hit named `item_added` to `https://sgtm.pingwright.invalid` at once. In `pagehide` it sends a GA4 `add_to_cart` with `sendBeacon`, which stub mode does not capture. The scenario should wait about 3 s before it navigates.

## Pinterest page

`/pinterest` loads the standard Pinterest tag snippet and the real `s.pinimg.com/ct/core.js` (needs internet access). Tag ID `2612345678901`, fake email `pinterest-fixture@example.com`. On load, with no consent step, it fires `init`, `pagevisit`, `addtocart` and `checkout` to `ct.pinterest.com`. Stub collection paths so no hit leaves the machine. The page has no banner, on purpose.

## Tracker page

`/tracker` needs no internet access. It loads `thirdPartyUrl/i18n/pixel/events.js` (script), POSTs `thirdPartyUrl/api/v2/pixel?event=Purchase&url=...` (a TikTok-style pixel), and loads `http://criteo.localhost:<p3>/m/collect?event=viewItem&callback=pwCriteo` as a script (a Criteo-style JSONP collection). Neither host is in the built-in list. Tests list host `127.0.0.1` for tiktok and `criteo.localhost` with path `/m/collect` for criteo in a `--tracker-list` file.

## Stable IDs page

`/stable-ids` loads the shop banner and, after 1.5 s and again after 2.5 s, POSTs one fake SHA-256 client ID under `clientIdHash`, `client_id_hash`, `external_id`, `uid`, `user_id`, `id` and `uuid` to `thirdPartyUrl/stable-ids/data`, and loads `thirdPartyUrl/stable-ids/session?hmac=<hex>&id=<same hash>`. With `?leak=email` it also POSTs the hash of `other.person@example.com` as `external_id` once.

## Server container Data Tag page

`/sgtm-data-tag` posts a `purchase` body to `sgtmUrl/data?v=2&event=purchase` (a JSON body sent as `text/plain`). The values are SHA-256 hashes of the identity typed in the checkout form, read from `sessionStorage` (`pw_checkout`), so a scenario fills `/checkout` and then visits this page. `?form=top` (default) is the Stape Data Tag protocol 2 shape: `email_address`, `first_name`, `last_name`, `street`, `city`, `postal_code` and `country` as hashed top-level fields, and an empty `phone_number`. `?wrong=postal` or `?wrong=country` hashes `00000` or `FR` for that one field, so a run must fail `identity.hashesMatch`. `?form=nested` sends `event_name`, `page_location` and `customerHashed.email` only. `?form=flat-email` sends the same with a top-level `email`. Both hash the typed email. In every form, the email is `pw-fixture@example.com` when nothing was typed, not only in `nested` and `flat-email`. `?form=list` sends a `user_data` object with `email_address` and `phone_number` as one-item lists and `address` as a one-item list of objects.

## Shared hashes page

`/shared-hashes` loads the shop banner and the script `/assets/app-<64 hex>.js` (served from `assets/hashed-app.js`). After 1.5 s it sends a GraphQL persisted-query POST (`{"id":"<hex>"}`) to `thirdPartyUrl/graphql/persisted`, and a GET to the same path with `id` and an `extensions` query holding `persistedQuery.sha256Hash`. All hex values are made up. With `?leak=email` it also sends `em=<hash of other.person@example.com>` to `thirdPartyUrl/shared-hashes/collect`. `?leak=nested` sends the hash of the same address as `variables.customer.id` on the persisted-query POST, and `?leak=pixel` requests an image at `thirdPartyUrl/shared-hashes/u-<hash>.gif`.

## Meta Purchase without hashes page

`/meta-purchase-no-hash` loads the shop banner and, after 0.8 s, sends one Meta `Purchase` hit for the fake pixel `100000000000001` with no `ud[em]` or `ud[ph]` values.

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

## Pages for 0.3

`/sgtm-leak`, `/identifiers`, `/cookies` and `/select` load `/assets/banner.js`, not `site.js`: a banner (`#pw-consent-banner`, `#pw-accept`, `#pw-reject`, `#pw-cookie-settings`), a Consent Mode default with all four signals denied, and no sandboxed pixel, no unknown pixel, no gtag.js and no fbevents.js. `/tiles`, `/handoff` and `/handoff/second` load neither script and have no banner, so a scenario must not use a consent step on them. All of these pages need no internet access. Hits to `google-analytics.com` and `facebook.com` are images that a test or a stub-mode run answers locally. Hits to `sgtmUrl` go to the loopback mock host. A run with these pages can exit 0. A scenario that adds a page with `site.js` sets `builtins: { sandboxPageUrl: warn }`.

`/sgtm-leak` uses the identity typed in `/checkout`, read from `sessionStorage` (`pw_checkout`), with fakes (`pw-fixture@example.com`) when nothing was typed. `/identifiers` has its own form (`#email`, `#phone`): the scenario fills it with identity steps before the consent step, and the typed values are also stored in `pw_checkout`.

| Page | Switches | What it sends | Consent step |
| --- | --- | --- | --- |
| `/sgtm-leak` | `?mode=allowlist`, `?mode=huge` | POSTs a JSON body (as `text/plain`) to `sgtmUrl/data?v=2&event=page_view` on load, and `event=after_consent` after the banner is answered. The default body holds `event_name`, `page_location`, `page_title`, `email`, `phone`, `address`, `cookie_data` and `clientIdHash`. `allowlist` holds `event_name`, `page_location`, `page_title`, `page_referrer`. `huge` is the default body plus a `padding` field, over 64 KiB. | Accept or reject. The first hit is in the undecided epoch, the second in the epoch of the answer. |
| `/identifiers` | `?state=denied` (default) or `granted`; `?control=1` | Nothing until the banner is answered, then 400 ms later: GA4 `/g/collect` with `uid` and `ep.token`, Meta `/tr` `Purchase` with `ud[em]` and `external_id`, and `sgtmUrl/data?v=2&event=purchase` with `user_data.email_address` and `external_id`. All hashes are the SHA-256 of the email typed in `#email` when the hits go out (the stored or default identity if the field is empty). `state` sets `gcs` on the GA4 and server hits (`G100` or `G111`). `control` sends only a GA4 hit with `cid` and a Meta `PageView` with `fbp`. | Reject for `denied`, accept for `granted`. |
| `/cookies` | `?when=before` (default) or `after` | `/session/start` on the shop answers `Set-Cookie: _pwid=pwfake-0001` (204). `before` requests it on load, `after` only once the banner is answered. A script sets `_ga_PWTEST`. A fetch to `sgtmUrl/pwcookie?pk=<base64 of /data?v=2&event=page_view>` (Stape loader form) answers `Set-Cookie: _pwdcid=pwfake-client.0001`. `/pwcookie` is a separate path, so `/pwstape` answers do not change. | `after` needs accept or reject. |
| `/tiles` | `?theme=button` (default), `radio`, `radio-mixed`, `plain` | Nothing. `radio-mixed` is `radio` with a link (`Size guide`) and a button (`Help`) before the radios. Tiles titled and labelled `White (01)` and `Black (02)` (the name is visible text inside the tile, and nowhere else on the page before a click): `role=button`, `role=radio`, or a `div` with a `title`. A click shows the title in `#selected`. | None. |
| `/select` | `?send=hash`, `?broken=1`, `?autocomplete=cc-exp-month` | A `<select name="countryCode">` (`#country-code`) with values and labels (`DE` / `Germany`). `#current` shows the value. `send=hash` posts `sgtmUrl/data?v=2&event=country_selected` with `country` set to the SHA-256 of the lower-case value. `broken=1` resets the select to `""` inside the change event. `autocomplete=cc-exp-month` makes it a month select (`#exp-month`, values `01` to `12`) with that autocomplete value, a card field. | Accept or reject for `send=hash`. |
| `/set-cookie-unstored` | none | Loads the banner. On load, requests `/session/unstored` on the shop, which answers `Set-Cookie: _pwunstored=pw-fixture-cookie-value; Domain=other.example`. The domain does not match the host, so the browser always rejects the cookie, whatever its third-party cookie policy. | Accept or reject. |
| `/set-cookie-already` | none | Loads the banner. On load, a script sets `_pwalready`. One second later it requests `/session/already`, which answers `Set-Cookie: _pwalready=pw-fixture-cookie-value; Domain=other.example`. The browser rejects that header, but the script's cookie is already in the jar, so a checkpoint taken before the request holds the name. | Accept or reject. |
| `/meta-early` | none | Loads neither `site.js` nor `banner.js`: no banner and no Consent Mode default. Sends one Meta `PageView` image hit for pixel `100000000000001` at once, so the consent state stays unknown. | None. |
| `/handoff-patched` | none | A button `#handoff-submit` and an inline script that patches the `Node.prototype.textContent` setter, the `HTMLElement.prototype.style` getter and `getRootNode` before any other script. They record what they receive in `window.__pwPatched` (`textContent`, `style`, `rootNodes`). The page never calls them itself. | None. |
| `/handoff`, `/handoff/second` | `?listener=1` | A form (`#note`, `#handoff-submit`, result in `#saved`) and a link `#to-second`. `listener=1` adds a document-level click listener that loads a GA4 image from `www.google-analytics.com`. | None. |

For a stub-mode run, `/pwcookie` is a Stape loader request, so stub mode answers it and the `Set-Cookie` is not seen. Only a mode that lets the request through shows it. List `sgtmUrl` as an allowed destination, because the mock host is not a known vendor.

## Pages for 0.4

| Page | Switches | What it sends or does | Consent step |
| --- | --- | --- | --- |
| `/handoff/until` | none | A link `#pw-to-thank-you` to `/thank-you-late`. Sends nothing. | None. |
| `/thank-you-late` | none | 2 s after load, a GA4 `purchase` image hit for `G-PWTEST0001` (`transaction_id` `fixture-order-0002`) to `www.google-analytics.com`. A handoff that ends at the URL match with no settle time misses it. | None. |
| `/checkout/test-payment` | `?marker=off` | A top page on `localhost` with a test-mode marker `#pw-test-mode`, a plain `#card-number` input on the top page, a card iframe from `paymentFrameUrl` (`/card-frame`, cross-origin) with `#cc-number`, `#cc-exp` and `#cc-csc` (`cc-*` autocomplete), and `#pay`. `#pay` asks the frame to post its card number to its own origin, then goes to `/thank-you-late`. `marker=off` leaves out `#pw-test-mode`. Loads neither banner nor tags. | None. |
| `/viewport` | none | Pushes a dataLayer event `layout_mobile` when `innerWidth` is below 600, else `layout_desktop`, and sends a GA4 image hit with that event name. Pushes `ua_mobile: true` when the user agent contains `Mobile`. | None. |

`/unload-gap` takes a `mode` switch that the gap frame reads. Without `mode` the page is as described above. `?mode=custom`: 1.8 s after load the frame pushes `custom_add`, sends a `/data` hit named `custom_add` and a GA4 `/g/collect` hit named `custom_add_ga` to `https://sgtm.pingwright.invalid`, and sends nothing in `pagehide`. `?mode=close`: the frame pushes `add_to_cart` and holds the hit until `pagehide`. The scenario does not navigate, so the hit goes out only when the page closes.
