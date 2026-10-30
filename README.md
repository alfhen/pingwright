<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
    <img alt="Pingwright" src="brand/lockup.svg" width="327" height="64">
  </picture>
</h1>

Agent-first testing for tags and consent. Pingwright plays a visitor in a real browser, records every tracking hit the site sends, and checks the result against what you expect. Reports of which tags fired are planned.

> **Status: 0.2 release candidate (`0.2.0-rc.1`).** Pingwright plays a visitor in Chromium, records and decodes hits, answers the consent banner, checks YAML expectations and writes a JSONL record. 0.2 adds a GTM workspace override, `pingwright diff`, a Pinterest decoder, stubbing of known tracker hosts and a Shopify checkout pattern. The rest of this README describes where Pingwright is going, and marks what is not built yet. The design is in [docs/design.md](docs/design.md). Feedback is welcome in issues.
>
> **In 0.1:** `pingwright run` with `stub` and `live` network modes; consent epochs, with withdrawals labelled apart from first rejects; seeded fake identities, hash checks and leak detection; decoders for GA4, Google Ads, Meta, Stape custom loader and a minimal server-container data client; banner handling through autoconsent; expectations; JSONL output.
>
> **In 0.2:** `--gtm-override` runs the page against an unpublished GTM web workspace, also through a Stape-style custom loader; `pingwright diff` compares two runs; a Pinterest decoder; a curated tracker list (LinkedIn, Microsoft UET, Reddit) that is stubbed and recorded as minimal hits, extendable with `--tracker-list` (X, for example); a record schema version; a Shopify checkout pattern ([docs/shopify-checkout.md](docs/shopify-checkout.md)).
>
> **Not built yet:** MCP server, `report`, GTM tag-firing reporters, `server` network mode, Shopify bridge, a full Microsoft UET decoder, Firefox and WebKit.

## Why

Tracking setups break quietly. A trigger change lets a pixel fire before consent. A container update sends hits to the wrong place. A consent banner update stops the analytics tags. The usual tools for catching this need a person:

- Google Tag Assistant and GTM Preview show which tags fired, but only to a signed-in person clicking through a page.
- Browser extensions decode hits in DevTools, but nothing can call them.
- Commercial auditing services run in their own cloud, on their own schedule.

Pingwright is built so that a coding agent, a CI job or a person can answer these questions with one command and get structured results:

- What did the site send to each vendor, before and after the visitor's consent choice?
- Which tags fired for each event, and which expected tags did not? (Planned, not built yet.)
- Does an unpublished GTM workspace behave as intended, before you publish it? Run the same scenario with and without `--gtm-override` and compare the two records with `pingwright diff`. (In 0.2.)

## What it does

1. **Plays a visitor.** A Playwright browser opens your site, answers the consent banner (accept, reject, or no answer), visits pages, fills forms with a fake identity and adds to cart. Steps that a tool must not do, such as paying or logging in, are handoff steps: a person acts in a visible window while recording continues.
2. **Records requests** from the page and from all iframes, including sandboxed iframes such as Shopify custom pixels. Capture from service workers works in Chromium only, and requests to the collector origin from dedicated workers are captured too. Each run reports which sources it covered.
3. **Decodes hits.** Vendor plugins turn raw requests into readable hits: GA4 events and consent state, Google Ads, Meta and Stape server-container traffic. Pinterest is decoded in 0.2. Hosts on the tracker list, such as LinkedIn, Microsoft UET and Reddit, give minimal hits with the vendor name. A full Microsoft UET decoder is not built yet.
4. **Reports tag firing (not built yet).** An optional GTM template reports which tags fired or failed for each event, in the web container and the server container. Agents get this without a Google sign-in. Given the container's tag list, Pingwright also reports which expected tags did not fire.
5. **Checks expectations.** Each scenario lists what must and must not happen, for example "no Meta request before consent" or "GA4 hits after a reject carry no user ID". Pingwright reports pass or fail, with the evidence. A scenario that names a vendor Pingwright does not know is rejected when it is parsed.
6. **Checks hashing.** Because Pingwright knows the fake identity it typed, it can check that the hashed email and phone sent to Google and Meta are correct.
7. **Compares runs.** `pingwright diff` shows what changed per vendor and per event between two runs, for example before and after a GTM change.

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
npm i -g --install-links github:alfhen/pingwright#v0.2.0-rc.1
pingwright install-browser
```

Node 22.18 or later. `--install-links` is needed: without it, npm 10 links the global package to a temporary clone that it then deletes. Install from a release tag only: tags carry a built `dist/`, branches such as main do not. The other option is a tarball: in a checkout, run `pnpm install && pnpm build && pnpm pack`, then `npm i -g ./pingwright-<version>.tgz`. See [docs/cli.md](docs/cli.md).

## Quick start

1. `npm i -g --install-links github:alfhen/pingwright#v0.2.0-rc.1`
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

`consent: none` needs a banner that autoconsent detects. If none is shown, the run stops with "banner not shown" and exit code 2. Vendor keys are `ga4`, `google-ads`, `meta`, `pinterest`, `sgtm`, and every vendor on the tracker list (`linkedin`, `microsoft-uet`, `reddit`) or in a `--tracker-list` file. A scenario that names any other vendor is rejected when it is parsed.

Stub mode is the default: known collection endpoints are recorded and answered locally. Unknown destinations still receive hits and are flagged as `unknownDestination`, which fails the run. The registrable domain of `--site` is first party: for `--site https://www.shop.co.uk`, `shop.co.uk` and every `*.shop.co.uk` host are not unknown. Data-carrying requests to those subdomains that no decoder matches, such as server-side GTM on `sgtm.shop.co.uk/collect`, are listed as `firstPartySubdomain` flags, grouped by host. They do not fail the run. Hosts without a registrable domain, such as IP addresses and `localhost`, are first party only as the exact `--site` host. If a site serves its own assets from another domain, list it under `options: { firstPartyHosts: ['i.example-cdn.com', '*.example-static.com'] }`. To accept specific unknown hosts without calling them first party, use `options: { allowUnknownDestination: ['tracker.example.net'] }`; every other unknown destination still fails. `allowUnknownDestination: true` allows all of them, and the summary still lists them. A request sent while a sandboxed `srcdoc` iframe is loading can escape stubbing and recording (see [design §5.3](docs/design.md)). Use `--network live` to let everything through. Pingwright decodes GA4, Google Ads, Meta, Pinterest and Stape traffic, and stubs the hosts on the tracker list. Hits to other vendors, such as TikTok, are not stubbed unless you add them with `--tracker-list`: they pass through and can only show up as `unknownDestination` flags.

## Override and diff quick start

Run one scenario against the published container and against an unpublished workspace, then compare.

1. Get the preview values for the workspace from the GTM UI, a GTM API client or a GTM MCP server. Pingwright never calls the GTM API. Write them to `override.json`:

   ```json
   {"container": "GTM-XXXXXXX", "gtmAuth": "…", "gtmPreview": "env-12"}
   ```

2. Run the scenario twice:

   ```bash
   pingwright run scenario.yml --site https://staging.example.com --out runs/published
   pingwright run scenario.yml --site https://staging.example.com --out runs/workspace --gtm-override override.json
   ```

3. Compare the two records:

   ```bash
   pingwright diff runs/published/run_<id>.jsonl runs/workspace/run_<id>.jsonl
   ```

`diff` lists added, removed and changed hits per consent epoch, vendor and event, and changed flag counts per host. Add `--by-page` to pair hits page by page, or `--json` for the full result. It exits 0 whether or not the runs differ; the exit code of each `run` tells you whether its rules passed.

The override fetches the workspace build of `gtm.js?id=<container>` and answers the page with it. If no request matched, or the build did not return 200, the run exits 2. The `gtmAuth` value never appears in the record or in any output. For a site that loads the container through a Stape-style custom loader, the override works through the loader by default. Add `"loader": {"replace": "<script URL>"}` to replace the loader script instead. Details are in [docs/cli.md](docs/cli.md).

## Tracker list

In `stub` mode, Pingwright stubs and records requests to a curated list of tracker hosts, so a pixel without a decoder no longer leaks to the vendor. The list is small, kept in the repo, and each entry links to the vendor's own docs. A listed request becomes a minimal hit with the vendor name, so rules, flags and `diff` work on it. Add your own entries with `--tracker-list`:

```json
[{"vendor": "acme", "host": "t.example.com", "paths": ["/collect"], "source": "https://docs.example.com/pixel"}]
```

```bash
pingwright run scenario.yml --site https://staging.example.com --tracker-list trackers.json
```

`vendor` is a lowercase key you can then use in `expect` rules. `host` is an exact host or `*.domain`. `paths` is optional. See [docs/cli.md](docs/cli.md) for the matching rules.

## Safe by default

- **Known collection endpoints are stubbed by default.** Scripts load normally, but requests to known collection endpoints are recorded and answered locally. Unknown destinations pass through, so test hits can still reach vendors that way. Requests to hosts outside the site's registrable domain are flagged when they are `fetch`, `xhr`, `ping` or `beacon` requests, or images or other requests that carry a query or a body. They are flagged as `unknownDestination`. Scripts, stylesheets, fonts and documents are not flagged. Requests a sandboxed `srcdoc` iframe sends while it loads can escape stubbing and recording (design §5.3). Pingwright lets them through because blocking by host would stop vendor scripts from loading and make a broken setup look compliant. Use `--network live` to let everything through.
- **Fake identities.** Every run uses a generated test identity. Pingwright flags any email, phone number or hashed identifier in a recording that does not belong to that identity.
- **No payments or log-ins.** On a hosted site these are always handoff steps for a person, who should use test accounts and test cards. Only loopback hosts, such as the fixture shop, may be automated through a fake payment form.
- **You own the data.** There is no Pingwright-hosted service. When server-side reports are built, they will go to a sink you run: a tunnel to your machine, or a small Worker in your own Cloudflare account.

## For agents

The MCP server is not built yet. It will let an agent run a scenario, query the records, read tag firing per event, and compare runs. Today an agent can call the CLI: `run --json` and `diff --json` print structured results. Every record has a stable ID, and every result names the run and step.

Pingwright will not change GTM containers or sign in to Google. An agent that edits a workspace with a GTM API client (for example a GTM MCP server) passes the workspace preview values to Pingwright for one run with `--gtm-override`.

## Packages

| Package | Job | State |
| --- | --- | --- |
| `core` | IDs, clock, record types, record schema version, JSONL run store, fake identity | 0.2 |
| `recorder` | Launch the browser, play steps, capture requests, responses, cookies and dataLayer events, GTM override | 0.2 |
| `decoders` | One plugin per vendor, with synthetic fixtures as tests | 0.2 (GA4, Google Ads, Meta, Pinterest, Stape, server-container data client, tracker list) |
| `consent` | Banner handling through DuckDuckGo autoconsent, Consent Mode probe, epochs | 0.1 |
| `expect` | Scenario format, expectations, diff engine | 0.2 |
| `cli` | `pingwright run`, `diff`, `install-browser` | 0.2 |
| `gtm` | Tag-firing reporter templates | not built yet |
| `platforms/shopify` | Custom-pixel bridge, sandbox URL handling, checkout handoff | not built yet |
| `mcp` | MCP server | not built yet |

## Related tools

- **EDPS website-evidence-collector** records cookies and beacons, including before consent. Pingwright adds vendor decoding, expectations and diffs. Tag reports are planned.
- **DuckDuckGo autoconsent** handles consent banners. Pingwright uses it.
- **Snowplow Micro** does local, assertable event collection for Snowplow trackers.
- **ObservePoint**, **DataTrue** and **Trackingplan** are commercial services for tag auditing and monitoring.
- **Avo**, **Segment Protocols** and **Amplitude Data** govern the schema of your own product events.

## License

[MIT](LICENSE)
