# Pingwright

Agent-first testing for tags and consent. Pingwright plays a visitor in a real browser, records every tracking hit the site sends, tells you which tags fired and why, and checks the result against what you expect.

> **Status: design stage.** Nothing here runs yet. This README describes what Pingwright will do. The design is in [docs/design.md](docs/design.md). Feedback is welcome in issues.

## Why

Tracking setups break quietly. A trigger change lets a pixel fire before consent. A container update sends hits to the wrong place. A consent banner update stops the analytics tags. The usual tools for catching this need a person:

- Google Tag Assistant and GTM Preview show which tags fired, but only to a signed-in person clicking through a page.
- Browser extensions decode hits in DevTools, but nothing can call them.
- Commercial auditing services run in their own cloud, on their own schedule.

Pingwright is built so that a coding agent, a CI job or a person can answer these questions with one command and get structured results:

- What did the site send to each vendor, before and after the visitor's consent choice?
- Which tags fired for each event, and which did not?
- Does an unpublished GTM workspace behave as intended, before you publish it?

## What it does

1. **Plays a visitor.** A Playwright browser opens your site, answers the consent banner (accept, reject, or no answer), visits pages and adds to cart. Steps that a tool must not do, such as paying or logging in, are handoff steps: a person acts in a visible window while recording continues.
2. **Records every request,** from the page and from iframes, including sandboxed iframes such as Shopify custom pixels.
3. **Decodes hits.** Vendor plugins turn raw requests into readable hits: GA4 events and consent state, Google Ads, Meta, Pinterest, Microsoft UET, TikTok, Criteo, and server-side GTM traffic.
4. **Reports tag firing.** An optional GTM template reports which tags fired for each event, in the web container and the server container. Agents get what Tag Assistant shows, without a Google sign-in.
5. **Checks expectations.** Each scenario lists what must and must not happen, for example "no Pinterest request before consent" or "GA4 hits after a reject carry no user ID". Pingwright reports pass or fail, with the evidence.
6. **Compares runs.** `pingwright diff` shows what changed per vendor and per event between two runs, for example before and after a GTM change.

## A scenario

```yaml
# scenarios/undecided-visitor.yml
start: /products/{product}
steps:
  - consent: none          # do not answer the banner
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

- **Nothing reaches vendors unless you ask.** The default network mode records each vendor request and then blocks it, so test runs do not pollute production analytics or ad accounts. Use `--network live` to let requests through.
- **No payments or log-ins.** These are always handoff steps for a person.
- **Personal data is masked** in recordings before they are written to disk.
- **You own the data.** Server-side reports go to a sink you run: a tunnel to your machine, or a small Worker in your own Cloudflare account. There is no Pingwright-hosted service.

## For agents

Pingwright ships an MCP server. An agent can run a scenario, query the hits, read tag firing per event, and compare runs. Every result carries a run ID and a step label, so an agent can say exactly which request came from which step and which tag.

## Planned packages

| Package | Job |
| --- | --- |
| `recorder` | Launch the browser, play steps, capture requests, cookies and consent state |
| `decoders` | One plugin per vendor, with recorded fixtures as tests |
| `consent` | Banner adapters (Usercentrics, Cookiebot, OneTrust, Didomi) and consent-state probes |
| `gtm` | Tag-firing reporter templates, workspace preview loading |
| `collector` | Local HTTPS endpoint that ties browser, platform and GTM reports to one run |
| `platforms/shopify` | Custom-pixel bridge, sandbox URL handling, checkout handoff |
| `expect` | Scenario and expectation format, run diffs |
| `mcp`, `cli` | The two ways in |

## Related tools

- **Snowplow Micro** does local, assertable event collection for Snowplow trackers. Pingwright aims to do the same for tag managers and ad pixels.
- **ObservePoint**, **DataTrue** and **Trackingplan** are commercial services for tag auditing and monitoring.
- **Avo**, **Segment Protocols** and **Amplitude Data** govern the schema of your own product events.

## License

[MIT](LICENSE)
