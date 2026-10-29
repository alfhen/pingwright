# Pingwright design

Status: revision 5, for release candidate 0.1.0-rc.1. Milestone 0.1 is built (§15); the rest is design. Claims marked **(verify)** are believed true but not tested in code, and each one says so. Revision 2 took in an adversarial design review and the CodeRabbit review on PR #1. Revision 3 records verification results. Revision 4 adds the recorder results. Revision 5 resolves the 0.1 claims and adds §15.1, the differences in 0.1.

## 1. Problem

A modern tracking setup has four or more layers: the site or theme, a consent banner, a tag manager in the browser, and often a server-side tag manager. Each layer can change on its own, and a change in one layer can make another layer send data it should not, or stop sending data it should.

Today the ways to check this are:

- **GTM Preview and Tag Assistant.** They show which tags fired, but only to a signed-in person in a browser UI.
- **Network inspection by hand.** DevTools or an extension shows the raw requests. It does not scale, and nothing can call it.
- **Commercial auditing services.** They run scheduled crawls in their own cloud. They cannot test an unpublished change, and they are not built for agents.

Pingwright makes this checkable by a program: a coding agent, a CI job, or a person running one command.

## 2. Goals and non-goals

**Goals**

1. Record what a site sends to each tracking vendor, for a scripted visitor, at each consent state.
2. Report which tag manager tags fired or failed, per event, without a signed-in person. Report which expected tags did not fire, when the caller supplies the container's tag list.
3. Test an unpublished GTM workspace before publishing it, in the test browser only.
4. Express expected behaviour as data, and report pass or fail with evidence.
5. Compare two runs per vendor and per event.
6. Expose all of this to agents through MCP, with stable, structured results.
7. Be safe by default: fake identities, no payments, no hosted service, and known collection endpoints stubbed. Unknown destinations still receive test hits, and every one is flagged (§5.3).

**Non-goals**

- Production monitoring of real visitor traffic. Tools such as Trackingplan do this.
- A schema registry for product events. Tools such as Avo do this.
- Explaining why a tag did not fire. GTM exposes no trigger evaluation data outside its own debugger.
- Changing GTM containers. Agents use a GTM API client for that (§8.2). Pingwright only takes the values it needs as input.
- Legal advice on consent. Pingwright shows what is sent. Whether that is allowed is for the site owner to decide.
- A hosted service. Every part runs on infrastructure the user controls.

## 3. Architecture

```
            scenario.yml  +  run options (GTM preview, expected tags)
                 │
          ┌──────▼──────┐   requests, responses, cookies,   ┌──────────────┐
          │  recorder   │── consent epochs, dataLayer ─────▶│              │
          │ (Playwright)│                                   │              │
          └──────┬──────┘                                   │              │
                 │ loads site                               │  run store   │──▶ runs/<id>.jsonl
    ┌────────────▼─────────────┐   posts to the            │  (in-process)│
    │ page + iframes + workers │   collector origin,       │              │
    │  • consent banner        │   answered by             │              │
    │  • platform sandbox ─────┼── context.route ─────────▶│              │
    │  • web GTM reporter ─────┼──────────────────────────▶│              │
    └────────────┬─────────────┘                           │              │
                 │ hits                                     │              │
          ┌──────▼──────┐  signed server tag reports        │              │
          │ server GTM  │──────▶ sink (user's tunnel ──────▶│              │
          └──────┬──────┘        or user's Worker)          └──────┬───────┘
                 ▼                                                 │
              vendors                              decoders → expect → report / diff
                                                                   │
                                                            CLI  ·  MCP server
```

## 4. Data model

All output is JSON. A run is one scenario played once.

Every record has a stable `id` with a type prefix and a sortable unique suffix (ULID), for example `req_01J…`, `hit_01J…`. All references between records use these IDs, never list positions. Evidence and links resolve the same way regardless of ordering or filtering.

| Entity | Fields (main) |
| --- | --- |
| `Run` | `id` (`run_…`), `scenario`, `site`, `startedAt`, `pingwrightVersion`, `browser` (name and version), `networkMode`, `gtmOverride`, `containerVersions` (read from `google_tag_manager[id]` where exposed), `identity` (the fake identity used, §13) |
| `Step` | `id` (`stp_…`), `runId`, `index`, `label`, `startedAt`, `endedAt` |
| `Request` | `id` (`req_…`), `runId`, `stepId`, `t`, `method`, `url`, `resourceType`, `frameUrl`, `initiator`, `headers` (secrets redacted), `postData` (size-capped), `outcome` (`passed`, `stubbed`, `failed`) |
| `Response` | `id` (`res_…`), `requestId`, `status`, `setCookieNames[]` |
| `Hit` | `id` (`hit_…`), `runId`, `stepId`, `requestId`, `t`, `vendor`, `event`, `consent`, `ids`, `page`, `transport`, `params` |
| `DataLayerEvent` | `id` (`dle_…`), `runId`, `stepId`, `t`, `event`, `gtmUniqueEventId`, `args` (the pushed arguments, JSON-safe), `isConsentCommand` |
| `TagReport` | `id` (`tag_…`), `runId`, `stepId`, `container`, `side` (`web` or `server`), `event`, `gtmUniqueEventId`, `tags[]` (`id`, `name` or `null`, `status`, `executionTime`) |
| `ConsentEpoch` | `id` (`cep_…`), `runId`, `startT`, `endT`, `source`, `state` (§7.3) |
| `Checkpoint` | `id` (`ckp_…`), `runId`, `stepId`, `label`, `consentState` (per probe), `cookies[]` (`name`, `domain`, `expires`, `firstParty`) |
| `Result` | `id` (`rsl_…`), `runId`, `expectation`, `pass`, `evidence[]` (record IDs) |

`t` is milliseconds on one shared clock (§7.3).

`consent` on a `Hit` is normalised to `{analytics, ads, adUserData, adPersonalization}`, each `granted`, `denied` or `unknown`, plus the raw vendor value. Only Google hits carry consent in the hit itself. For other vendors, every value is `unknown`, and expectations fall back to the consent epoch the hit falls in.

`ids` records whether an identifier was present (`user_id`, `client_id`, hashed email, click IDs), and for hashed identity fields, whether it matches the run's fake identity (§13).

A `Hit` links to a `TagReport` only as a **probable** link: same `gtmUniqueEventId` where available, otherwise the same event within a short time window. Links carry `confidence: probable`.

## 5. Recorder

### 5.1 Browser profiles

| Profile | Use |
| --- | --- |
| `chromium` (default) | Playwright's Chromium. |
| `firefox` | Optional. |
| `webkit` | Later, for Safari tracking-prevention behaviour. |

Every profile:

- Uses a fresh context per run.
- Sends a normal browser user agent. Some consent banners treat headless user agents as bots and grant consent automatically, which silently invalidates a run. This is not an attempt to hide automation, and it does not hide `navigator.webdriver` or other signals. The real guard is the "banner shown" check (§7.1).
- Needs no certificate trust and no browser flags in the default design, because reports go to a collector origin that Playwright answers itself (§9). A real local HTTPS collector is not available yet (§9). If one is added, it must use a trusted local CA: `ignoreHTTPSErrors` applies to the whole browser context, not one origin, so it must not be used for this.
- Must run outside restrictive process sandboxes. Browsers fail to launch inside some agent command sandboxes.

### 5.2 Capture

- All hooks are on the browser context: `context.on('request')`, `context.on('response')` and `context.route`. Page-level hooks miss service-worker traffic.
- Covered: the page and all frames, including sandboxed iframes, except requests a sandboxed `srcdoc` iframe sends while it is loading, which are usually neither routed nor reported (§9), and sends from `pagehide` or `visibilitychange`, which the page answers itself in stub mode (§5.3).
- Service workers: Playwright reports and routes their requests on the context, in Chromium only. Requests to update a service worker's own script cannot be routed. Option: `serviceWorkers: 'block'`.
- Dedicated workers: **verified** on Chromium 156.0.8078.4 with Playwright 1.64.1. Requests to the collector origin are routed and seen from a worker on the page and from a worker inside a sandboxed iframe (`collector-origin.e2e.test.ts`). Requests from a dedicated worker to an ordinary host are recorded (`network-modes.e2e.test.ts`, the dedicated worker test), and the startup self-test reports `dedicatedWorker` coverage (`recorder.e2e.test.ts`).
- A startup self-test loads a routed page at `https://selftest.pingwright.invalid/`. The page, a sandboxed iframe and a dedicated worker each send a report to the collector origin. The run states its capture coverage: `{page, iframe, dedicatedWorker, serviceWorker: 'chromium-only'}`. Self-test reports are not stored. The self-test does not probe early iframe requests: a probe cannot tell a request that bypassed capture from one that was never sent (§5.3).
- An init script hooks `dataLayer.push` and records each push with a timestamp on the shared clock (§7.3).
- Checkpoints run at the end of each step and after each consent action.

### 5.3 Network modes

| Mode | Behaviour |
| --- | --- |
| `stub` (default) | Scripts, libraries and pages load normally. Known **collection endpoints** (decoder-listed paths such as GA4 `/g/collect` and Meta `/tr`) are recorded, then answered locally. Requests to known vendor hosts (Meta, Google ad hosts and `googletagmanager.com`) are also stubbed by host: collection paths for every resource type, and any other request that is not a script, stylesheet, font or document load. Library loads such as `gtag/js` and `fbevents.js` continue. Site functions on those hosts (`/recaptcha`, `/maps`, `/plugins`, `/dialog`, `/login`) continue too. Unknown third-party destinations pass through and are flagged in the report as `unknownDestination`. |
| `server` | As `stub`, but requests to the configured server-container hosts pass through. Required for server-side tag reports, server-set cookies and the server preview header. |
| `live` | Everything goes through. Test hits reach real vendor accounts. |

Why unknown destinations pass rather than being blocked: blocking by host stops vendor libraries from loading, which hides the very hits a test is looking for, and makes a broken setup look compliant. Flagging them makes them visible without changing the site's behaviour.

Stub answers: 204 for `fetch`, `xhr` and beacon requests, a 1x1 GIF for images, an empty 200 JavaScript response for scripts (gtag.js sends some Ads hits as script requests), and an empty 200 HTML response for documents (such as `td.doubleclick.net` iframes). The CORS headers echo the request `Origin` and allow credentials. Reports mark stubbed requests with `outcome: stubbed`. In `live` mode every request continues and has `outcome: passed`.

**Unknown destination rule.** A request is flagged `unknownDestination` when its host is not the site's host, no decoder matches it, and it can carry data: a `fetch`, `xhr` or beacon request, or an `image` or `other` request with a query string or a body. Scripts, stylesheets, fonts and documents are never flagged.

**Stubbing side effects (verified).** On Chromium 156.0.8078.4 with Playwright 1.64.1 and the real gtag.js (`packages/recorder/test/e2e/stubbing-side-effects.e2e.test.ts`), the same results held for a 204, a 1x1 GIF and a 204 delayed by 2 seconds:

- GA4 sent each event once, as a `POST` through `fetch`. It did not retry on another transport, such as an image or a beacon.
- A gtag `event_callback` fired in under 1.5 s of the `gtag('event')` call (the test's bound), without waiting for any response. A stub therefore does not change callback timing. A site that waits on a tag callback does not wait for the vendor, with or without stubbing.
- GA4 sent events other than `page_view` several seconds after the call.

Other vendors were not tested in 0.1.

**Unload-time sends (verified).** On Chromium 156.0.8078.4 with Playwright 1.64.1, Chromium neither routes nor reports requests a page sends from `pagehide` or `visibilitychange` (probe: `sendBeacon` and `fetch` with `keepalive` to a local server and to the collector origin; the server received them and `context.on('request')` saw none). Binding calls from those handlers are lost too. Real gtag.js sends a GA4 `fetch` with `keepalive` at that moment on every same-tab navigation, so without a fix stub mode would leak it. In `stub` mode the init script therefore answers `sendBeacon` and `fetch` with `keepalive` locally while the page is hidden or unloading. It queues each one in `sessionStorage` until the binding call is acknowledged, and the next same-origin document in the tab, or `close()`, replays the queue. These requests are recorded with `initiator: unload` and `outcome: stubbed`. Limits: every unload-time beacon is swallowed, not only collection endpoints. A send is unrecorded, though still not sent, if the tab navigates to another origin, or comes from a sandboxed iframe without `allow-same-origin`. Other transports used during unload (image, XHR) are not covered. Test: `network-modes.e2e.test.ts`.

**Limit: early iframe requests.** A request sent while a sandboxed `srcdoc` iframe is loading is usually not routed, so it is not stubbed and reaches the network. It is then also not reported by `context.on('request')`. Locally on Chromium 156.0.8078.4 with Playwright 1.64.1 this happened in 5 of 5 runs of `network-modes.e2e.test.ts` (the srcdoc test). On CI the same request was once routed and stubbed, so the outcome depends on timing. The test accepts either outcome and logs which one it saw. The recorder cannot record or flag such a request, so a collection hit sent this way can leave the machine unrecorded in `stub` mode. The recorder still flags any collection request it sees but did not route as `stubBypass`.

### 5.4 Steps

`visit`, `click`, `fill` (from the fake identity, §13), `consent` (`accept`, `reject`, `none`, or a named choice), `wait`, `addToCart` (through the platform adapter or a selector), `evaluate`, `checkpoint`, and `handoff`.

The scenario's `start` is played first, as step 0 labelled `start`. A step may carry `label: <name>`; the default is the kind and the step's index (`click-3`), and a checkpoint is named by its value. Labels are unique, and `after:` must name one. Each Request, Hit and DataLayerEvent carries the id of the step that was running when it was recorded, and a step that ends records a checkpoint of the cookies. A `fill` on a card or password field (autocomplete `cc-*`, `type=password`, or a name or id matching card, cvc, cvv, iban or password) fails unless the page host is loopback.

`handoff` opens a visible window, prints what the person must do and a reminder to use test accounts and test cards, and keeps recording until the person signals done. Pingwright never automates payment or log-in on a hosted site. The one exception is a loopback host (`localhost`, `127.0.0.1`, `::1`), such as Pingwright's own fixture shop, where no real payment can happen. There, a scenario may fill a fake payment form so the test suite can cover a whole checkout.

## 6. Decoders

A decoder is a plugin: `match(request) → boolean`, `decode(request) → Hit[]`, and `isCollectionEndpoint(request) → boolean` for `stub` mode. The check takes the request, not a fixed list, because some endpoints are only known after decoding (for example Stape's disguised paths). One request can hold several hits (GA4 batches events in the POST body, one per line).

| Decoder | Notes |
| --- | --- |
| `ga4` | Event name (`en`), parameters (`ep.*`, `epn.*`), `uid` presence, `cid`, measurement ID (`tid`), batched bodies. Consent from `gcs` and `gcd`. |
| `google-ads` | Conversion and remarketing pings, including `/ccm/collect` on google.com, doubleclick and googlesyndication hosts. Multi-hop chains are recorded as linked requests. |
| `meta` | `facebook.com/tr`: `ev`, `id`, `eid`. |
| `pinterest` | `ct.pinterest.com`: `event`, `tid`, `pd` presence. |
| `microsoft-uet` | `bat.bing.com`: `evt`, `ti`. A missing `ti` is reported as a defect. |
| `tiktok`, `criteo`, `snapchat`, `linkedin` | Later. |
| `sgtm-data-client` | Requests to a server container's data client path (`/data`): event name, decoded `dtdc` payload (page location, page hostname). |
| `stape-custom-loader` | Stape's custom loader disguises paths as `/<id>?<key>=<base64>`. This decoder base64-decodes the real path and query, then passes the request to the other decoders. |

**`gcs` meaning.** The value has the form `G1xy`: `x` is `ad_storage`, `y` is `analytics_storage`, `1` is granted and `0` is denied. So `G100` is both denied and `G111` is both granted. `gcd` carries more detail, including `ad_user_data` and `ad_personalization`, and whether each value was a default or an update. The decoder keeps the raw values beside the normalised ones.

**Page URL check.** Decoders report the page URL the vendor received. A built-in expectation flags page URLs that point at a sandbox frame (for example Shopify's `/web-pixels@…/sandbox/` path) instead of the real page.

Every decoder ships with fixture requests and expected hits as tests. Fixtures use fake identities only.

## 7. Consent

### 7.1 Answering the banner

Pingwright uses DuckDuckGo's open-source [autoconsent](https://github.com/duckduckgo/autoconsent) (MPL-2.0) for `accept` and `reject`. It covers a large number of consent banners, and its rules mostly click the real buttons. Clicking matters: site code often listens to the banner's click events, and calling a banner's JavaScript API directly would skip that code.

autoconsent is used as an unmodified dependency. Changes to its files would have to stay under MPL-2.0, so fixes go upstream.

For `consent: none`, Pingwright asserts that a banner was detected and shown, then answers nothing. If no banner is shown, the run fails with "banner not shown", rather than recording a visitor who was silently consented.

### 7.2 Consent-state probes

| Probe | Reads |
| --- | --- |
| Google Consent Mode | `consent` commands in the dataLayer, in order, from the `dataLayer.push` hook |
| IAB TCF | `__tcfapi('addEventListener')` (TCF v2.2; `getTCData` is deprecated) |
| IAB GPP | `__gpp('ping')` |
| Shopify | `Shopify.customerPrivacy.currentVisitorConsent()`, after `Shopify.loadFeatures([{ name: 'consent-tracking-api' }])`. Not available on checkout pages. |

### 7.3 Consent epochs and timing

"Before consent" needs a precise meaning.

- **One clock.** The init script records dataLayer pushes and banner events with `performance.timeOrigin + performance.now()`. Request times are converted to the same clock.
- **Epochs.** Each banner action defines a window from a short lead before it starts to a pair window (default 2 s) after it ends. Consent Mode updates inside the window belong to that decision. The epoch starts at the earliest of the action end and those updates, is labelled by the action, and takes the last Consent Mode state in the window (the action's own state if no update came). An update outside every window that changes state starts its own epoch with source `consentMode`, except that while undecided an update that grants nothing only updates the undecided state. A run can have several epochs, for example accept and then withdraw.
- **Google hits** are judged by the consent value inside the hit (`gcs`, `gcd`), not by timing. This handles hits that were queued before an update and sent after it.
- **Other vendors** are judged by the epoch their request falls in. A configurable grace window (default 50 ms) covers tags that legitimately fire on the consent-update event itself.

Rules: `before: consent` means "in the first epoch, while the state is undecided". `in: epoch(<state>)` matches hits in any epoch with that state.

## 8. GTM

### 8.1 Web tag-firing reporter

A custom tag template, published to the Community Template Gallery.

- **Trigger and consent.** Fires on every event when a debug signal is present (a cookie set by the recorder). Its consent setting must be "no additional consent required", or reports go missing exactly in the before-consent window.
- **Data.** Calls `addEventCallback`. The callback runs once the tags for the event have run, and receives the container ID and event data. The event data includes `tags[]` with `id`, `status` and `executionTime`, plus each tag's monitoring metadata.
- **Only fired tags appear.** Tags blocked by triggers or consent do not appear. "Did not fire" is computed by comparing against an expected tag list the caller supplies (§8.2).
- **Tag names.** Names are present only when tags have monitoring metadata with a tag-name key. A missing name is reported as `null` (unknown). Name-based rules (`tags.mustFire`, `tags.mustNotFire`) treat an unknown name as "cannot evaluate" and report that, instead of passing or failing. Rules can also match by tag ID.
- **Permissions.** The template needs `read_event_metadata` for `addEventCallback`, and a sending permission (for example `send_pixel`) limited to the collector origin field. Which web template API can send the report body is still open **(verify)**. Not tested in 0.1. Template tests check the permissions and the URL limit.
- **What it sends.** `{runId, event, gtmUniqueEventId, tags[]}` to the collector origin. Never event data.
- **Exposure.** A published template ships to all visitors. Any visitor could set the debug cookie and make their own browser post to the collector origin, which resolves nowhere for them. Keep the reporter in workspace or environment versions where possible.

### 8.2 Testing an unpublished workspace

Pingwright does not call the GTM API. The caller supplies the preview values, so Pingwright needs no Google sign-in. Ways to get them:

- **An agent with a GTM MCP server,** for example Stape's GTM MCP server, which can edit a workspace and run a quick preview.
- **A CI script** using the GTM API with a Google service account added as a container user.
- **By hand,** from the GTM UI.

The values are a GTM override, passed with the run:

```json
{"container": "GTM-XXXXXXX", "gtmAuth": "…", "gtmPreview": "env-12", "expectedTags": [{"id": "45", "name": "GA4 - Purchase"}]}
```

The recorder intercepts the request for the container script with `context.route` and either calls `route.continue({ url })` with the preview build URL (`https://www.googletagmanager.com/gtm.js?id=<container>&gtm_auth=…&gtm_preview=env-N&gtm_cookies_win=x`), or fetches that URL with `route.fetch({ url })` and fulfils with the response. The override belongs to that run only. It is never stored as a shared setting.

Limits:

- Sites that load the container through a custom loader (for example Stape's) lose whatever that loader does beyond fetching the container. Hits still go to the configured server container URL.
- An environment with no version assigned returns 404.
- Only the test browser is affected.

**Server workspaces.** For an unpublished server container workspace, the caller supplies the server preview header value (`X-Gtm-Server-Preview`). In `server` mode the recorder adds it to requests for the server-container hosts.

### 8.3 Server tag-firing reporter

A server-side tag template with the same job. The server-side `addEventCallback` exists: it runs once all tags for the event have run, and its `tags[]` has `id`, `status` and `executionTime` plus metadata ([server-side API reference](https://developers.google.com/tag-platform/tag-manager/server-side/api)).

- **Gating.** The server container is public, so a header alone is not enough: anyone could send it. The recorder sends a run token: run ID, timestamp, and a signature of both under a secret held in a template field. The template recomputes the signature and drops requests that do not match or are older than a few minutes. Signature method: HMAC-SHA256 if the server template APIs offer it **(verify)**, otherwise SHA-256 over secret, run ID and timestamp. Not tested in 0.1.
- **Target.** It posts only to the sink address in its template field. It never takes an address from the incoming request. Its `send_http` permission is limited to that address.
- **What it sends.** Run ID, event name, client name, tag statuses and the consent state the server saw. Never the event payload.
- **Not visible.** The server container's own outgoing requests, for example to Meta's Conversions API, are not recorded. The reporter shows only whether those tags succeeded.
- **The sink** authenticates the template (for example with a Cloudflare Access service token), accepts only run IDs Pingwright issued, and rate-limits writes.

### 8.4 The sink

The server container runs on a remote host and cannot reach the user's machine. The user runs the sink. Pingwright runs no service. Any HTTPS endpoint that accepts an authenticated POST works.

| Option | When |
| --- | --- |
| Named Cloudflare Tunnel on the user's own domain, protected by Cloudflare Access | Local development |
| A small Worker in the user's own Cloudflare account, storing reports in D1 or KV | CI and unattended runs |
| Any other endpoint the user controls | Anything else |

Setup commands for the tunnel and the Worker are deferred until after the first releases.

## 9. Collector and run store

- **Collector origin.** The platform bridge and the web reporter post to a reserved origin, `https://collector.pingwright.invalid/`. The recorder answers these requests itself through `context.route`. No DNS lookup, private address, certificate or browser flag is involved, so Chrome's local-network checks do not apply.
  - **Verified** on Chromium 156.0.8078.4 with Playwright 1.64.1, no browser flags (`packages/recorder/test/e2e/collector-origin.e2e.test.ts`). `context.route` answers the collector origin, and `context.on('request')` sees it, from: page `fetch`, `navigator.sendBeacon`, a dedicated worker, a sandboxed `srcdoc` iframe (`sandbox="allow-scripts"`), a sandboxed cross-site iframe (top page on `localhost`, iframe on `127.0.0.1`, so out of process), and a worker inside a sandboxed iframe. It also works from a sandboxed iframe on a page served as `https://shop.pingwright.test/` through `context.route`. Firefox and WebKit were not tested.
  - **Direct fetch.** From that same public-looking page, a sandboxed iframe's `fetch` to `http://localhost:<port>` fails and the server is never reached. This was the same in every run. A local listener would not work there.
  - **Early requests.** A request sent while a sandboxed `srcdoc` iframe is still loading is usually neither routed nor reported by `context.on('request')`; on CI it was once routed (§5.3). This holds for every destination, not only the collector. In probes the collector request failed with `ERR_NAME_NOT_RESOLVED` (5 of 5 runs). A request to a local server (`/g/collect?early`) with a stubbing route in place was not routed and reached the server (3 of 3 runs). Requests sent 100 ms after load (20 ms in a probe) were captured. `context.on('request')` also does not see such a request (§5.3). The recorder must not rely on reports sent during iframe load, and in stub mode such a request can leave the machine unrecorded.
- **Authorisation.** Because the requests never leave the browser context, nothing outside the test browser can write to the run store. The run ID is a label, not a credential.
- **Validation.** Every incoming report is checked against a schema. Invalid reports are kept as `invalidReport` records, not dropped silently.
- **Sink reader.** Server reports are read from the configured sink with the sink's credentials.
- **Correlation.** The run ID travels in a cookie and, for server-container hosts, in the signed run token header. It does not travel in URL parameters, which redirects and checkouts drop.
- **Storage.** Each run is written to `runs/<id>.jsonl`. There is no fixed in-memory cap.
- **No fallback yet.** A local HTTPS listener could replace the reserved origin where interception does not work, but it is not available until its write authorization is defined. Browser-context isolation (above) does not protect a real listener, and a trusted local CA only authenticates the listener to the browser. It does not decide who may write. If the reserved origin cannot be intercepted on a platform, that platform is unsupported until then.

## 10. Platforms

### 10.1 Shopify

- **Custom pixel bridge.** A small snippet for a custom pixel that copies pushes to the collector origin when the debug cookie is set. It is inert otherwise.
- **Sandbox handling.** Custom pixels run in a sandboxed iframe whose URL contains `/web-pixels@…/sandbox/`. Decoders report that path as a defect when it reaches vendors as the page URL.
- **Checkout.** Checkout pages run no theme code. Add to cart goes through the cart API. Checkout payment is always a handoff step.
- **Theme preview.** `preview_theme_id` is a scenario variable, so an unpublished theme can be tested.

Other platforms come later and only if someone needs them.

## 11. Expectations

Scenario files are YAML. An expectation is a filter over records, plus a rule.

| Rule | Meaning |
| --- | --- |
| `must` | At least one match (or `count`) |
| `mustNot` | No match |
| `before: consent` | Only in the first epoch, while undecided (§7.3) |
| `in: epoch(<state>)` | Only in epochs with that consent state |
| `after: <step>` | Only after a named step |
| `tags.mustFire`, `tags.mustNotFire` | Over tag reports, by tag ID or name pattern. An unknown name is "cannot evaluate", not a pass or fail. |
| `identity.hashesMatch` | Hashed identity fields sent to a vendor match the run's fake identity (§13) |

Filters support `vendor`, `event`, `consent.*`, `ids.*`, `page` (with `matches`), `transport`, `host`, `outcome` and `params.*`.

`pingwright diff a b` groups hits by vendor and event and reports added, removed and changed hits, including consent and ID changes.

## 12. Interfaces

**CLI:** `pingwright run`, `pingwright diff`, `pingwright report` (terminal, JSON, JUnit).

**MCP tools:**

| Tool | Returns |
| --- | --- |
| `run_scenario(file, options)` | Run ID and summary. `options` can hold a GTM override (§8.2), a server preview header, and an expected tag list. Overrides apply to this run only. |
| `list_runs(filter)` | Runs with scenario, site, time, result |
| `get_records(runId, type, filter)` | Hits, requests, responses, tag reports, dataLayer events, epochs or checkpoints |
| `get_record(id)` | One record by ID, from any run |
| `diff_runs(a, b)` | Per-vendor, per-event differences |
| `handoff_status(runId)` | Whether a run waits for a person |

Every result includes record IDs, the run ID and the step label. Errors say what was expected and what was found. The MCP output schema is frozen before 0.2.

## 13. Test identities, privacy and security

**Fake identities.** Each run gets a seeded identity generated with Faker: name, email, phone, address. `fill` steps type it into forms. The seed is stored with the run, so a run can be repeated exactly.

**Hash checks.** Because the run knows its identity, it can check that vendors received the right hashes. For example, the hashed email in GA4 `user_data` or in Meta's `em` should equal the SHA-256 of the normalised fake email. A mismatch points at broken hashing or normalisation.

**Leak detection instead of masking.** Pingwright does not try to mask personal data. It flags it. Any email, phone number or hashed identifier in a recording that does not come from the run's identity is reported as `possibleRealData`, with the request and step. Detection runs after decoding (base64, URL encoding), so encoded values are found too.

Real data can still appear through:

- Handoff steps, if a person uses a real account or card, or autofill inserts saved details.
- Staging stores that hold copies of real customer data.

The docs and the handoff prompt tell people to use test accounts and test cards.

**Secrets are always redacted:** the run token, sink credentials and any `Authorization` or cookie header values Pingwright adds.

**Other rules**

- Playwright traces, HAR files and screenshots are off by default. When turned on, the report states that they are unfiltered.
- MCP results go to the agent's model provider. With fake identities this is acceptable. Flagged `possibleRealData` values are replaced with a placeholder in MCP output.
- Pingwright never enters passwords or payment data on a hosted site. Those steps are handoffs. Only loopback hosts are exempt (§5.4).
- Pingwright never takes a target address from incoming traffic.

## 14. Risks and open questions

1. **Collector origin interception.** Verified in Chromium 156.0.8078.4 with Playwright 1.64.1 for the sources listed in §9 (`collector-origin.e2e.test.ts`), once the sandboxed iframe has loaded. Open: requests sent during sandboxed `srcdoc` iframe load are usually not routed or seen, and reach the network; Firefox and WebKit are untested. There is no fallback yet: a local listener needs write authorization first (§9).
2. **Early iframe requests can escape stub mode and capture.** A tracking hit fired while a sandboxed `srcdoc` iframe loads is usually not recorded and not stubbed (§9). P09 confirmed that `context.on('request')` does not see these requests either (§5.3), so the recorder cannot detect them from the network. Open: block or rewrite `srcdoc` iframes, or detect them in the page.
   Unload-time sends are handled in the page in stub mode, with the limits in §5.3.
3. **Dedicated worker capture.** Verified in Chromium 156.0.8078.4 with Playwright 1.64.1 (§5.2). The startup self-test still reports coverage per run.
4. **Stubbing side effects.** Verified for GA4 in Chromium 156.0.8078.4 with Playwright 1.64.1 (§5.3). Other vendors are untested in 0.1.
5. **Server template signature APIs (verify).** Not tested in 0.1.
6. **Web template sending permission (verify).** Not tested in 0.1.
7. **Custom loaders.** Swapping the container script loses loader-specific behaviour (§8.2).
8. **Banner bot detection** changes over time. Guard: the "banner shown" check.
9. **Scope.** Many vendors and banners exist. Decoders are plugins, and banner handling is delegated to autoconsent.

## 15. Milestones

1. **0.1:** recorder with `stub` and `live` modes, consent epochs, fake identities, `ga4`, `meta`, `google-ads` and `stape-custom-loader` decoders, autoconsent, YAML expectations, CLI, JSONL output.
2. **0.2:** MCP server (schema frozen first), `diff`, `pinterest` and `microsoft-uet` decoders.
3. **0.3:** web tag-firing reporter template, GTM override per run, expected tag lists.
4. **0.4:** Shopify platform, collector origin bridge.
5. **0.5:** `server` mode, server reporter, sink reader.

Deferred: HTML report, sink setup commands, a replay page.

### 15.1 Differences in 0.1

Where the code in 0.1 differs from the design above:

- **`sgtm-data-client` is minimal.** It decodes only `/data` requests that carry a `dtdc` parameter, and reports vendor `sgtm` with the event name, `page_location` as `page`, `tid` and `page_hostname` in `params`, presence of `cid` and `uid` as `ids.client_id` and `ids.user_id` (not their values), and consent. It does not know other data client paths.
- **Only Meta and Google hosts are stubbed by host.** Hits to vendors without a 0.1 decoder (Pinterest, Microsoft UET, TikTok and others) pass through in `stub` mode and can only appear as `unknownDestination` flags.
- **`unknownDestination` is a built-in check.** A flagged request fails the run unless the scenario sets `options.allowUnknownDestination: true`. The rule for what is flagged is in §5.3.
- **Fake Meta pixel ID is `100000000000001`.** fbevents.js rejects IDs that start with 0 and sends no `/tr`.
- **Loopback payment exception.** Card and password fields can be filled on `localhost`, `127.0.0.1` and `::1` only (§5.4). On any other host the run fails and the step must be a `handoff`.
- **Install from git needs `--install-links`.** With npm 10, a global git install without it links to a temporary clone that npm deletes. Only release tags carry a built `dist/`, so install from a tag, not a branch (`docs/release.md`). A tarball from `pnpm install && pnpm build && pnpm pack` also works (`docs/cli.md`).
- **Consent answers are `accept`, `reject`, `none` and `withdraw`.** Named choices are not supported. Only the Google Consent Mode probe exists; TCF, GPP and Shopify probes are not built.
- **Network modes are `stub` and `live`.** `server` mode is not built.
- **Commands are `run`, `install-browser` and `--version`.** `diff`, `report` and the MCP server are not built.
- **Rules are `must`, `mustNot`, `count`, `before`, `in`, `after` and `identity.hashesMatch`.** `tags.mustFire` and `tags.mustNotFire` need the GTM reporters, which are not built. The `TagReport` record type exists and no 0.1 code writes it.
- **Chromium only.** There is no Firefox or WebKit profile. Playwright's Firefox does not start on the macOS used for development.
- **Decoders are `ga4`, `google-ads`, `meta`, `sgtm-data-client` and `stape-custom-loader`.** `pinterest` and `microsoft-uet` are not built.
- **Verification used Chromium 156.0.8078.4 and Playwright 1.64.1.** Other versions are untested.

## 16. Related tools

| Tool | Overlap |
| --- | --- |
| [EDPS website-evidence-collector](https://github.com/EU-EDPS/website-evidence-collector) | Open source. Records cookies and beacons, including before consent. Pingwright adds vendor decoding, expectations, diffs and tag reports. |
| [DuckDuckGo autoconsent](https://github.com/duckduckgo/autoconsent) | Used by Pingwright for banners. |
| [DuckDuckGo Tracker Radar](https://github.com/duckduckgo/tracker-radar) | Possible source for classifying unknown destinations. |
| Playwright MCP | Gives agents raw browser and network access. Pingwright adds decoding and assertions on top. |
| Snowplow Micro | The same idea for Snowplow trackers only. |
| ObservePoint, DataTrue, Trackingplan | Commercial auditing and monitoring. |
