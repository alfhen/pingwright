# Pingwright

Agent-first testing for tags and consent. Pingwright plays a visitor in a real browser, records every tracking hit the site sends, reports which tags fired, and checks the result against what you expect.

> **Status: design stage.** Nothing here runs yet. This README describes what Pingwright will do. The design is in [docs/design.md](docs/design.md). Feedback is welcome in issues.

## Why

Tracking setups break quietly. A trigger change lets a pixel fire before consent. A container update sends hits to the wrong place. A consent banner update stops the analytics tags. The usual tools for catching this need a person:

- Google Tag Assistant and GTM Preview show which tags fired, but only to a signed-in person clicking through a page.
- Browser extensions decode hits in DevTools, but nothing can call them.
- Commercial auditing services run in their own cloud, on their own schedule.

Pingwright is built so that a coding agent, a CI job or a person can answer these questions with one command and get structured results:

- What did the site send to each vendor, before and after the visitor's consent choice?
- Which tags fired for each event, and which expected tags did not?
- Does an unpublished GTM workspace behave as intended, before you publish it?

## What it does

1. **Plays a visitor.** A Playwright browser opens your site, answers the consent banner (accept, reject, or no answer), visits pages, fills forms with a fake identity and adds to cart. Steps that a tool must not do, such as paying or logging in, are handoff steps: a person acts in a visible window while recording continues.
2. **Records requests** from the page and from all iframes, including sandboxed iframes such as Shopify custom pixels. Capture from service workers works in Chromium only, and capture from dedicated workers is not yet verified. Each run reports which sources it covered.
3. **Decodes hits.** Vendor plugins turn raw requests into readable hits: GA4 events and consent state, Google Ads, Meta, Pinterest, Microsoft UET, and server-side GTM traffic.
4. **Reports tag firing.** An optional GTM template reports which tags fired or failed for each event, in the web container and the server container. Agents get this without a Google sign-in. Given the container's tag list, Pingwright also reports which expected tags did not fire.
5. **Checks expectations.** Each scenario lists what must and must not happen, for example "no Pinterest request before consent" or "GA4 hits after a reject carry no user ID". Pingwright reports pass or fail, with the evidence.
6. **Checks hashing.** Because Pingwright knows the fake identity it typed, it can check that the hashed email and phone sent to Google and Meta are correct.
7. **Compares runs.** `pingwright diff` shows what changed per vendor and per event between two runs, for example before and after a GTM change.

## A scenario

```yaml
# scenarios/undecided-visitor.yml
start: /products/{product}
steps:
  - consent: none          # the banner must appear, and gets no answer
  - wait: 4s
  - visit: /collections/all
expect:
  mustNot:
    - { vendor: [pinterest, meta, tiktok], before: consent }
    - { vendor: ga4, ids.user_id: present, consent.analytics: denied }
  must:
    - { vendor: ga4, event: page_view, consent.analytics: denied, count: ">=2" }
```

```bash
pingwright run scenarios/undecided-visitor.yml --site https://staging.example.com
```

## Safe by default

- **Test hits do not reach vendors unless you ask.** By default, scripts load normally, but known collection endpoints are recorded and answered locally. Use `--network server` to test a server container, or `--network live` to let everything through. Unknown destinations are let through and flagged in the report, so a broken setup cannot look compliant.
- **Fake identities.** Every run uses a generated test identity. Pingwright flags any email, phone number or hashed identifier in a recording that does not belong to that identity.
- **No payments or log-ins.** These are always handoff steps for a person, who should use test accounts and test cards.
- **You own the data.** Server-side reports go to a sink you run: a tunnel to your machine, or a small Worker in your own Cloudflare account. There is no Pingwright-hosted service.

## For agents

Pingwright ships an MCP server. An agent can run a scenario, query the records, read tag firing per event, and compare runs. Every record has a stable ID, and every result names the run and step.

Pingwright does not change GTM containers or sign in to Google. An agent that edits a workspace with a GTM API client (for example a GTM MCP server) passes the workspace preview values and the expected tag list to Pingwright for one run.

## Planned packages

| Package | Job |
| --- | --- |
| `recorder` | Launch the browser, play steps, capture requests, responses, cookies, dataLayer events and consent changes |
| `decoders` | One plugin per vendor, with recorded fixtures as tests |
| `consent` | Banner handling through DuckDuckGo autoconsent, plus consent-state probes |
| `gtm` | Tag-firing reporter templates, workspace preview loading |
| `platforms/shopify` | Custom-pixel bridge, sandbox URL handling, checkout handoff |
| `expect` | Scenario and expectation format, run diffs |
| `mcp`, `cli` | The two ways in |

## Related tools

- **EDPS website-evidence-collector** records cookies and beacons, including before consent. Pingwright adds vendor decoding, expectations, diffs and tag reports.
- **DuckDuckGo autoconsent** handles consent banners. Pingwright uses it.
- **Snowplow Micro** does local, assertable event collection for Snowplow trackers.
- **ObservePoint**, **DataTrue** and **Trackingplan** are commercial services for tag auditing and monitoring.
- **Avo**, **Segment Protocols** and **Amplitude Data** govern the schema of your own product events.

## License

[MIT](LICENSE)
