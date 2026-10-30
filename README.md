# Pingwright

Agent-first testing for tags and consent. Pingwright plays a visitor in a real browser, records every tracking hit the site sends, and checks the result against what you expect. Reports of which tags fired are planned.

> **Status: 0.1 release candidate (`0.1.0-rc.1`).** 0.1 plays a visitor in Chromium, records and decodes hits, answers the consent banner, checks YAML expectations and writes a JSONL record. The rest of this README describes where Pingwright is going, and marks what is not built yet. The design is in [docs/design.md](docs/design.md). Feedback is welcome in issues.
>
> **In 0.1:** `pingwright run` with `stub` and `live` network modes; consent epochs; seeded fake identities, hash checks and leak detection; decoders for GA4, Google Ads, Meta, Stape custom loader and a minimal server-container data client; banner handling through autoconsent; expectations; JSONL output.
>
> **Not built yet:** MCP server, `diff`, `report`, GTM reporters and overrides, `server` network mode, Shopify bridge, Pinterest and Microsoft UET decoders, Firefox and WebKit.

## Why

Tracking setups break quietly. A trigger change lets a pixel fire before consent. A container update sends hits to the wrong place. A consent banner update stops the analytics tags. The usual tools for catching this need a person:

- Google Tag Assistant and GTM Preview show which tags fired, but only to a signed-in person clicking through a page.
- Browser extensions decode hits in DevTools, but nothing can call them.
- Commercial auditing services run in their own cloud, on their own schedule.

Pingwright is built so that a coding agent, a CI job or a person can answer these questions with one command and get structured results:

- What did the site send to each vendor, before and after the visitor's consent choice?
- Which tags fired for each event, and which expected tags did not? (Planned, not built in 0.1.)
- Does an unpublished GTM workspace behave as intended, before you publish it? (Not built yet.)

## What it does

1. **Plays a visitor.** A Playwright browser opens your site, answers the consent banner (accept, reject, or no answer), visits pages, fills forms with a fake identity and adds to cart. Steps that a tool must not do, such as paying or logging in, are handoff steps: a person acts in a visible window while recording continues.
2. **Records requests** from the page and from all iframes, including sandboxed iframes such as Shopify custom pixels. Capture from service workers works in Chromium only, and requests to the collector origin from dedicated workers are captured too. Each run reports which sources it covered.
3. **Decodes hits.** Vendor plugins turn raw requests into readable hits: GA4 events and consent state, Google Ads, Meta and Stape server-container traffic. Pinterest and Microsoft UET are not built yet.
4. **Reports tag firing (not built yet).** An optional GTM template reports which tags fired or failed for each event, in the web container and the server container. Agents get this without a Google sign-in. Given the container's tag list, Pingwright also reports which expected tags did not fire.
5. **Checks expectations.** Each scenario lists what must and must not happen, for example "no Meta request before consent" or "GA4 hits after a reject carry no user ID". Pingwright reports pass or fail, with the evidence. A rule on a vendor without a 0.1 decoder, such as Pinterest, matches nothing: a `mustNot` rule on it passes vacuously and a `must` rule fails.
6. **Checks hashing.** Because Pingwright knows the fake identity it typed, it can check that the hashed email and phone sent to Google and Meta are correct.
7. **Compares runs (not built yet).** `pingwright diff` shows what changed per vendor and per event between two runs, for example before and after a GTM change.

## A scenario

```yaml
# scenarios/undecided-visitor.yml
start: /products/{product}
vars:
  product: fake-tee
steps:
  - consent: none          # the banner must appear, and gets no answer
  - wait: 4s
  - visit: /collections/all
expect:
  mustNot:
    - { vendor: [meta, google-ads], before: consent }
    - { vendor: ga4, ids.user_id: present, consent.analytics: denied }
  must:
    - { vendor: ga4, event: page_view, consent.analytics: denied, count: ">=2" }
```

```bash
pingwright run scenarios/undecided-visitor.yml --site https://staging.example.com
```

## Install

```bash
npm i -g --install-links github:alfhen/pingwright#v0.1.0-rc.1
pingwright install-browser
```

Node 22.18 or later. `--install-links` is needed: without it, npm 10 links the global package to a temporary clone that it then deletes. Install from a release tag only: tags carry a built `dist/`, branches such as main do not. The other option is a tarball: in a checkout, run `pnpm install && pnpm build && pnpm pack`, then `npm i -g ./pingwright-<version>.tgz`. See [docs/cli.md](docs/cli.md).

## Quick start

1. `npm i -g --install-links github:alfhen/pingwright#v0.1.0-rc.1`
2. `pingwright install-browser`
3. Write `scenario.yml`:

   ```yaml
   start: /
   steps:
     - consent: none
     - wait: 4s
   expect:
     mustNot:
       - { vendor: [meta, google-ads], before: consent }
   ```

4. `pingwright run scenario.yml --site https://staging.example.com`
5. Read the summary, and the full record in `runs/run_<id>.jsonl`.

`consent: none` needs a banner that autoconsent detects. If none is shown, the run stops with "banner not shown" and exit code 2. Vendor keys in 0.1 are `ga4`, `google-ads`, `meta` and `sgtm`. A scenario that names any other vendor is rejected when it is parsed.

Stub mode is the default: known collection endpoints are recorded and answered locally. Unknown destinations still receive hits and are flagged as `unknownDestination`, which fails the run. The registrable domain of `--site` is first party: for `--site https://www.shop.co.uk`, `shop.co.uk` and every `*.shop.co.uk` host are not unknown. Data-carrying requests to those subdomains that no decoder matches, such as server-side GTM on `sgtm.shop.co.uk/collect`, are listed as `firstPartySubdomain` flags, grouped by host. They do not fail the run. Hosts without a registrable domain, such as IP addresses and `localhost`, are first party only as the exact `--site` host. If a site serves its own assets from another domain, list it under `options: { firstPartyHosts: ['i.example-cdn.com', '*.example-static.com'] }`. To accept specific unknown hosts without calling them first party, use `options: { allowUnknownDestination: ['tracker.example.net'] }`; every other unknown destination still fails. `allowUnknownDestination: true` allows all of them, and the summary still lists them. A request sent while a sandboxed `srcdoc` iframe is loading can escape stubbing and recording (see [design §5.3](docs/design.md)). Use `--network live` to let everything through. In 0.1, Pingwright decodes GA4, Google Ads, Meta and Stape traffic. Hits to other vendors, such as Pinterest, Microsoft UET or TikTok, are not stubbed: they pass through and can only show up as `unknownDestination` flags.

## Safe by default

- **Known collection endpoints are stubbed by default.** Scripts load normally, but requests to known collection endpoints are recorded and answered locally. Unknown destinations pass through, so test hits can still reach vendors that way. Requests to hosts outside the site's registrable domain are flagged when they are `fetch`, `xhr`, `ping` or `beacon` requests, or images or other requests that carry a query or a body. They are flagged as `unknownDestination`. Scripts, stylesheets, fonts and documents are not flagged. Requests a sandboxed `srcdoc` iframe sends while it loads can escape stubbing and recording (design §5.3). Pingwright lets them through because blocking by host would stop vendor scripts from loading and make a broken setup look compliant. Use `--network live` to let everything through.
- **Fake identities.** Every run uses a generated test identity. Pingwright flags any email, phone number or hashed identifier in a recording that does not belong to that identity.
- **No payments or log-ins.** On a hosted site these are always handoff steps for a person, who should use test accounts and test cards. Only loopback hosts, such as the fixture shop, may be automated through a fake payment form.
- **You own the data.** There is no Pingwright-hosted service. When server-side reports are built, they will go to a sink you run: a tunnel to your machine, or a small Worker in your own Cloudflare account.

## For agents

Not built yet. Pingwright will ship an MCP server. An agent can run a scenario, query the records, read tag firing per event, and compare runs. Every record has a stable ID, and every result names the run and step.

Pingwright will not change GTM containers or sign in to Google. An agent that edits a workspace with a GTM API client (for example a GTM MCP server) passes the workspace preview values and the expected tag list to Pingwright for one run.

## Packages

| Package | Job | State |
| --- | --- | --- |
| `core` | IDs, clock, record types, JSONL run store, fake identity | 0.1 |
| `recorder` | Launch the browser, play steps, capture requests, responses, cookies and dataLayer events | 0.1 |
| `decoders` | One plugin per vendor, with synthetic fixtures as tests | 0.1 (GA4, Google Ads, Meta, Stape, server-container data client) |
| `consent` | Banner handling through DuckDuckGo autoconsent, Consent Mode probe, epochs | 0.1 |
| `expect` | Scenario format and expectations | 0.1 (no `diff` yet) |
| `cli` | `pingwright run`, `install-browser` | 0.1 |
| `gtm` | Tag-firing reporter templates, workspace preview loading | not built yet |
| `platforms/shopify` | Custom-pixel bridge, sandbox URL handling, checkout handoff | not built yet |
| `mcp` | MCP server | not built yet |

## Related tools

- **EDPS website-evidence-collector** records cookies and beacons, including before consent. Pingwright adds vendor decoding and expectations. Diffs and tag reports are planned.
- **DuckDuckGo autoconsent** handles consent banners. Pingwright uses it.
- **Snowplow Micro** does local, assertable event collection for Snowplow trackers.
- **ObservePoint**, **DataTrue** and **Trackingplan** are commercial services for tag auditing and monitoring.
- **Avo**, **Segment Protocols** and **Amplitude Data** govern the schema of your own product events.

## License

[MIT](LICENSE)
