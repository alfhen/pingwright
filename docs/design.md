# Pingwright design

Status: draft for review. Nothing is built yet. Claims marked **(verify)** are believed true but not yet tested in code.

## 1. Problem

A modern tracking setup has four or more layers: the site or theme, a consent banner, a tag manager in the browser, and often a server-side tag manager. Each layer can change on its own, and a change in one layer can make another layer send data it should not, or stop sending data it should.

Today the ways to check this are:

- **GTM Preview and Tag Assistant.** They show which tags fired and why, but only to a signed-in person in a browser UI.
- **Network inspection by hand.** DevTools or an extension shows the raw requests. It does not scale, and nothing can call it.
- **Commercial auditing services.** They run scheduled crawls in their own cloud. They cannot test an unpublished change, and they are not built for agents.

Pingwright makes this checkable by a program: a coding agent, a CI job, or a person running one command.

## 2. Goals and non-goals

**Goals**

1. Record what a site sends to each tracking vendor, for a scripted visitor, at each consent state.
2. Report which tag manager tags fired, failed or did not fire, per event, without a signed-in person.
3. Test an unpublished GTM workspace before publishing it, in the test browser only.
4. Express expected behaviour as data, and report pass or fail with evidence.
5. Compare two runs per vendor and per event.
6. Expose all of this to agents through MCP, with stable, structured results.
7. Be safe by default: no pollution of vendor accounts, no payments, masked personal data, no hosted service.

**Non-goals**

- Production monitoring of real visitor traffic. Tools such as Trackingplan do this.
- A schema registry for product events. Tools such as Avo do this.
- Legal advice on consent. Pingwright shows what is sent. Whether that is allowed is for the site owner to decide.
- A hosted service. Every part runs on infrastructure the user controls.

## 3. Architecture

```
            scenario.yml
                 │
          ┌──────▼──────┐   requests, cookies,     ┌──────────────┐
          │  recorder   │── consent checkpoints ──▶│              │
          │ (Playwright)│                          │              │
          └──────┬──────┘                          │              │
                 │ loads site                      │              │
    ┌────────────▼─────────────┐                   │  collector   │──▶ runs/<id>.jsonl
    │ page + iframes           │  platform bridge  │ (local HTTPS)│
    │  • consent banner        │──────────────────▶│              │
    │  • platform sandbox      │  web tag reports  │              │
    │  • web GTM ──────────────┼──────────────────▶│              │
    └────────────┬─────────────┘                   │              │
                 │ hits                            │              │
          ┌──────▼──────┐  server tag reports      │              │
          │ server GTM  │──────▶ sink (tunnel or ─▶│              │
          └──────┬──────┘        user's Worker)    └──────┬───────┘
                 ▼                                        │
              vendors                         decoders → expect → report / diff
                                                          │
                                                   CLI  ·  MCP server
```

## 4. Data model

All output is JSON. A run is one scenario played once.

| Entity | Fields (main) |
| --- | --- |
| `Run` | `id`, `scenario`, `site`, `startedAt`, `browser`, `networkMode`, `gtmOverride` |
| `Step` | `runId`, `index`, `label`, `startedAt`, `endedAt` |
| `Request` | `runId`, `step`, `t` (ms since run start), `method`, `url`, `frameUrl`, `initiator`, `postData` (masked), `blocked` |
| `Hit` | `runId`, `step`, `t`, `vendor`, `event`, `consent`, `ids`, `page`, `transport`, `params`, `requestRef` |
| `TagReport` | `runId`, `step`, `container`, `event`, `tags[]` (`id`, `name`, `status`, `executionTime`) |
| `Checkpoint` | `runId`, `step`, `label`, `consentState` (per source), `cookies[]` (names only), `dataLayerConsent[]` |
| `Result` | `runId`, `expectation`, `pass`, `evidence[]` (refs to hits, requests, tag reports) |

`consent` on a `Hit` is normalised to `{analytics, ads, adUserData, adPersonalization}` with values `granted`, `denied` or `unknown`, plus the raw vendor value.

`ids` records **whether** an identifier was present (`user_id`, `client_id`, hashed email, click IDs), never its value.

## 5. Recorder

### 5.1 Browser profiles

| Profile | Use |
| --- | --- |
| `chromium` (default) | Playwright's Chromium. Launched with `--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessPermissionPolicy` so that sandboxed iframes can reach the local collector. Feature names confirmed present in Chromium 156. Chrome renames these flags between versions, so each Pingwright release pins a browser version. |
| `firefox` | Optional. Firefox does not apply Chrome's local-network checks. Note: Playwright's Firefox failed to start on one macOS 27 machine ("Could not find profile folder"), so it cannot be the default. |
| `webkit` | Later, for Safari tracking-prevention behaviour. |

Every profile:

- Uses a fresh context per run.
- Sends a normal browser user agent. Some consent banners treat headless user agents as bots and grant consent automatically, which silently invalidates a run. This was observed with one widely used banner.
- Trusts the collector's local certificate (`ignoreHTTPSErrors` for the collector origin, or an installed local CA).
- Must run outside restrictive process sandboxes. Browsers fail to launch inside some agent command sandboxes.

### 5.2 Capture

- `context.on('request')` captures requests from the page and all frames, including sandboxed iframes. Requests from dedicated workers and service workers need checking **(verify)**.
- For each request: URL, method, frame URL, initiator, post body (masked, size-capped), timing relative to run start, and the current step label.
- Checkpoints run at the end of each step and after each consent action: consent state from every probe (see §7), tracking cookie names, and the dataLayer consent commands.

### 5.3 Network modes

| Mode | Behaviour |
| --- | --- |
| `record-and-abort` (default) | Requests to known vendor hosts are recorded, then aborted. The site and the collector still work. Server-side tag reports are empty in this mode, because hits never reach the server container. |
| `live` | All requests go through. Needed to test the server container. Test hits reach real vendor accounts. |
| `allowlist` | Only listed hosts go through, for example the server container's own host. |

### 5.4 Steps

`visit`, `click`, `consent` (`accept`, `reject`, `none`, or a named custom choice), `wait`, `addToCart` (through the platform adapter or a selector), `evaluate` (a small script), `checkpoint`, and `handoff`.

`handoff` opens a visible window, prints what the person must do (for example "complete checkout with a test card"), and keeps recording until the person signals done. Pingwright never automates payment, log-in, or entering real personal data.

## 6. Decoders

A decoder is a plugin: `match(request) → boolean` and `decode(request) → Hit[]`. One request can hold several hits (GA4 batches events in the POST body, one per line).

| Decoder | Notes |
| --- | --- |
| `ga4` | Event name (`en`), parameters (`ep.*`, `epn.*`), `uid` presence, `cid`, measurement ID (`tid`), batched bodies. Consent from `gcs` and `gcd`. |
| `google-ads` | Conversion and remarketing pings, including `/ccm/collect` on google.com, doubleclick and googlesyndication hosts. |
| `meta` | `facebook.com/tr`: `ev`, `id`, `eid`. |
| `pinterest` | `ct.pinterest.com`: `event`, `tid`, `pd` presence. |
| `microsoft-uet` | `bat.bing.com`: `evt`, `ti`. A missing `ti` is reported as a defect. |
| `tiktok`, `criteo`, `snapchat`, `linkedin` | Later. |
| `sgtm-data-client` | Requests to a server container's data client path (`/data`): event name, decoded `dtdc` payload (page location, page hostname). |
| `stape-custom-loader` | Stape's custom loader disguises paths as `/<id>?<key>=<base64>`. This decoder base64-decodes the real path and query, then passes the request to the other decoders. |

**`gcs` meaning.** The value has the form `G1xy`: `x` is `ad_storage`, `y` is `analytics_storage`, `1` is granted and `0` is denied. So `G100` is both denied and `G111` is both granted. `gcd` carries more detail, including `ad_user_data` and `ad_personalization`, and whether each value was a default or an update. The decoder keeps the raw values beside the normalised ones.

**Page URL check.** Decoders report the page URL the vendor received. A built-in expectation flags page URLs that point at a sandbox frame (for example Shopify's `/web-pixels@…/sandbox/` path) instead of the real page.

Every decoder ships with fixture requests and expected hits as tests. Fixtures must not contain real personal data.

## 7. Consent

### 7.1 Banner adapters

Each adapter implements `isShown()`, `accept()`, `reject()`, `choose(spec)` and `waitForDecision()`.

First targets: Usercentrics, Cookiebot, OneTrust, Didomi. Each adapter prefers the banner's JavaScript API where one exists and falls back to accessible button names. Text matching uses a per-locale list.

A run with `consent: none` asserts that the banner was shown. If it was not, the run fails with "banner not shown", rather than recording a visitor who was silently consented.

### 7.2 Consent-state probes

| Probe | Reads |
| --- | --- |
| Google Consent Mode | `consent` commands in the dataLayer (default and updates, in order) |
| IAB TCF | `__tcfapi('getTCData')` |
| IAB GPP | `__gpp('ping')` |
| Shopify | `Shopify.customerPrivacy.currentVisitorConsent()` |
| Banner | The adapter's own state API |

Probes run at each checkpoint. Expectations can refer to any of them, for example "Shopify consent stays undecided until the visitor chooses".

## 8. GTM

### 8.1 Web tag-firing reporter

A custom tag template, published to the Community Template Gallery.

- It fires on every event, but only when a debug signal is present: a URL parameter, a cookie set by the recorder, or a dataLayer flag.
- It calls `addEventCallback`. For each event, the callback receives the container ID and event data, including the list of tags with `id`, `status` and `executionTime` **(verify the exact fields)**.
- Tag names are only present if tags have monitoring metadata with a tag-name key. The template's setup guide covers this.
- It posts `{runId, event, eventId, tags[]}` to the collector. The collector address is a template field.
- It never sends event data. Only event names, tag IDs, names and statuses.

### 8.2 Testing an unpublished workspace

The recorder can serve a workspace preview build in place of the live container, in the test browser only.

1. Create a quick preview of the workspace through the GTM API, or use an existing environment. This gives a `gtm_auth` and a `gtm_preview` (`env-N`) value.
2. Intercept the request for the container script with `page.route` and fulfil it with `https://www.googletagmanager.com/gtm.js?id=<container>&gtm_auth=…&gtm_preview=env-N&gtm_cookies_win=x`.

Limits:

- Sites that load the container through a custom loader (for example Stape's) lose whatever that loader does beyond fetching the container, such as first-party cookie handling. Hits still go to the configured server container URL.
- An environment with no version assigned returns 404.
- This only changes the test browser. Real visitors are not affected.

### 8.3 Server tag-firing reporter

A server-side tag template with the same job.

- It fires only when the incoming request carries the run header (`x-pingwright-run`), which the recorder adds to requests for the server container's hosts.
- It uses the server-side `addEventCallback` **(verify availability and fields)** and `sendHttpRequest`.
- It posts to a **sink**, never to an address taken from the request. Letting a request choose the target would let anyone make the server container send data to any address.
- It sends only run ID, event name, client name, tag statuses and the consent state seen by the server. Never the event payload.
- It authenticates to the sink with a token (template field), for example a Cloudflare Access service token.

### 8.4 The sink

The server container runs on a remote host and cannot reach a collector on the user's machine. The user runs the sink. Pingwright runs no service.

| Option | When |
| --- | --- |
| Named Cloudflare Tunnel to the local collector, on the user's own domain, protected by Cloudflare Access | Local development. `pingwright sink tunnel` sets it up through `cloudflared`. |
| Sink Worker in the user's own Cloudflare account, storing reports in D1 or KV | CI and unattended runs. `pingwright sink deploy` deploys it with the user's credentials. |
| Quick tunnel (`trycloudflare.com`) or ngrok | One-off sessions. The address changes each time, so the template field must be updated. |

The sink transport is a plugin. The collector reads from whichever sink is configured.

## 9. Collector

- A local HTTPS server (default port 3456) with a local certificate.
- Endpoints: `POST /platform` (platform bridge), `POST /tags` (web reporter), `GET /runs/:id`, and a reader for the configured sink.
- Correlates everything by run ID. The recorder puts the run ID in a cookie, a URL parameter and a request header. The platform bridge, the web reporter and the server reporter all include it.
- Writes each run to `runs/<id>.jsonl`. Keeps no fixed in-memory cap that drops events.
- Optional replay page: replays platform events into a copy of the container on a local page, for setups that cannot load the container in the site itself. It runs under a strict Content-Security-Policy (`connect-src 'self'`, `img-src 'self'`), so replayed tags fire and report but cannot send hits to vendors. Lookups keyed on the page hostname resolve differently on a local page. This must be stated in its output.

## 10. Platforms

### 10.1 Shopify

- **Custom pixel bridge.** A small snippet for a custom pixel that copies pushes to the collector when debug mode is on and a collector answers. It is inert otherwise.
- **Sandbox handling.** Custom pixels run in a sandboxed iframe whose URL contains `/web-pixels@…/sandbox/`. Decoders report that path as a defect when it reaches vendors as the page URL.
- **Checkout.** Checkout pages run no theme code. Add to cart goes through the cart API. Checkout payment is always a handoff step.
- **Theme preview.** `preview_theme_id` is a scenario variable, so an unpublished theme can be tested.

Other platforms (Magento, WooCommerce, headless sites) come later and only if someone needs them.

## 11. Expectations

Scenario files are YAML. An expectation is a filter over hits, requests, tag reports or checkpoints, plus a rule.

| Rule | Meaning |
| --- | --- |
| `must` | At least one match (or `count`) |
| `mustNot` | No match |
| `before: consent` | Only matches before the first consent decision in the run |
| `after: <step>` | Only matches after a named step |
| `tags.mustFire`, `tags.mustNotFire` | Over tag reports, with name patterns |

Filters support `vendor`, `event`, `consent.*`, `ids.*`, `page` (with `matches`), `transport`, `host`, and `params.*`.

`pingwright diff a b` groups hits by vendor and event and reports added, removed and changed hits, including consent and ID changes.

## 12. Interfaces

**CLI:** `pingwright run`, `pingwright diff`, `pingwright report` (terminal, JSON, JUnit, self-contained HTML), `pingwright sink tunnel|deploy`, `pingwright collector`.

**MCP tools:**

| Tool | Returns |
| --- | --- |
| `run_scenario(file, overrides)` | Run ID and summary: pass or fail per expectation |
| `list_runs(filter)` | Runs with scenario, site, time, result |
| `get_hits(runId, filter)` | Decoded hits |
| `get_requests(runId, filter)` | Raw requests (masked) |
| `get_tag_firings(runId, event?)` | Tag reports, web and server |
| `get_checkpoints(runId)` | Consent and cookie state per step |
| `diff_runs(a, b)` | Per-vendor, per-event differences |
| `preview_workspace(container, workspace)` | Sets up the GTM override for the next run |
| `handoff_status(runId)` | Whether a run waits for a person |

Every result includes the run ID and step label. Errors say what was expected and what was found.

## 13. Privacy and security

- Post bodies and URLs are masked before writing: email addresses, phone numbers and names are replaced. Hashed values are kept as "present" flags, not values. Masking rules are configurable.
- Recordings stay local unless the user exports them.
- The default network mode blocks vendor requests.
- The server reporter only acts on requests with the run header, and only sends metadata.
- The sink requires authentication. Pingwright never takes a target address from incoming traffic.
- Pingwright never enters passwords, payment data or real personal data. Those steps are handoffs.

## 14. Risks and open questions

1. **Chrome local-network flags change between versions.** Mitigation: pin the browser per release, test the flag at startup, and fail with a clear message.
2. **Banner bot detection.** Mitigation: a normal user agent, plus the "banner shown" assertion.
3. **`addEventCallback` field shapes,** web and server **(verify)**.
4. **Workers.** Requests from dedicated and service workers may need extra capture **(verify)**.
5. **Custom loaders.** Swapping the container script loses loader-specific behaviour (§8.2).
6. **Live mode pollutes vendor accounts.** Mitigation: `record-and-abort` default, and a warning on `live`.
7. **Sink exposure.** A misconfigured tunnel exposes the collector. Mitigation: Cloudflare Access by default, and the collector only accepts authenticated sink reads.
8. **Scope.** Many vendors and banners exist. Decoders and adapters are plugins, so the core stays small.

## 15. Milestones

1. **0.1:** recorder, `ga4`, `meta`, `pinterest`, `google-ads` and `stape-custom-loader` decoders, YAML expectations, CLI, JSONL output.
2. **0.2:** MCP server, `diff`, HTML report.
3. **0.3:** web tag-firing reporter template, workspace preview loading.
4. **0.4:** Shopify platform, banner adapters for the first four banners.
5. **0.5:** server tag-firing reporter, sink tunnel and sink Worker.
