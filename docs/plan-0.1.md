# Plan for milestone 0.1

This is the checklist for 0.1 (design §15). Each item is one small PR. A PR is done when its acceptance test passes in CI, an Opus review reports no blockers or majors, and it is squash-merged to main.

## Scope

In 0.1:

- recorder with `stub` (default) and `live` network modes
- consent epochs on one clock
- seeded fake identities, hash checks and leak detection
- decoders: `ga4`, `meta`, `google-ads`, `stape-custom-loader`, plus a minimal `sgtm-data-client` for Stape `/data` requests
- banner handling through `@duckduckgo/autoconsent`, used unmodified
- YAML expectations, `pingwright run`, JSONL output
- the reserved collector origin (§9), verified first

Not in 0.1: `server` mode, GTM reporters and overrides, Shopify bridge, MCP server, `diff`, `report`, TCF, GPP and Shopify consent probes, Firefox and WebKit profiles.

## Toolchain

- Node 22, TypeScript, pnpm 10.34.7 (pinned in `packageManager`), Vitest, ESLint.
- Playwright 1.64.1, pinned exactly. Chromium is the only profile in 0.1.
- `@duckduckgo/autoconsent` 16.51.0, pinned exactly.
- Dependencies are pinned to exact versions at least two weeks old.

## Package layout

```
package.json              root package "pingwright": the installable CLI bundle
pnpm-workspace.yaml
packages/
  core/                   @pingwright/core: IDs, clock, record types, JSONL run store, fake identity
  decoders/               @pingwright/decoders: decoder interface and vendor plugins
  recorder/               @pingwright/recorder: browser, capture, network modes, collector, steps
  consent/                @pingwright/consent: autoconsent driver, Consent Mode probe, epochs
  expect/                 @pingwright/expect: scenario YAML, filters, rules, built-in checks
  cli/                    @pingwright/cli: `pingwright run`
fixtures/
  site/                   @pingwright/fixture-site: local test shop and its server
e2e/                      end-to-end scenarios against the fixture site
```

`core` is not in the README table. Decoders, recorder, consent and expect all share the record types, so they live in one small package. The README table is updated to match.

Workspace packages are private. The root package `pingwright` bundles them with esbuild into `dist/`. Its runtime dependencies are only external packages (Playwright, autoconsent, yaml, Faker and similar). So `pnpm pack` at the root gives an installable tarball, and `npm i -g github:alfhen/pingwright#<tag>` works through the root `prepare` script.

## Rules for every PR

- Fake identities and fake IDs only. Fake GA4 ID `G-PWTEST0001`, fake Ads ID `AW-000000001`, fake Meta pixel `000000000000001`.
- Context-level hooks only: `context.on('request')`, `context.route`. No page-level hooks.
- A normal Chrome user agent, never `HeadlessChrome`.
- No browser flags in the default launch.
- E2E tests run against `fixtures/site` on localhost, in `stub` mode. A test that would let a collection hit leave the machine fails.
- Unit tests next to the code, e2e tests under `e2e/` or `packages/*/test/e2e/`.
- Short, plain docs and commit messages.

## PRs

Arrows show dependencies. PRs in the same wave touch different packages and can run in parallel.

### Wave 1

**P01 Workspace scaffold and CI.**
Root `package.json`, `pnpm-workspace.yaml`, shared `tsconfig`, ESLint flat config, Vitest config, `.gitignore` (including `.claude/`), empty `core` package with one test. CI workflow: install, lint, typecheck, unit tests, then an e2e job that installs Chromium and runs `pnpm e2e`.
Acceptance: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm e2e` passes locally and in CI.

### Wave 2 (after P01)

**P02 Collector origin verification (§9).** → P01
A Playwright test, with no Pingwright code yet, that answers `https://collector.pingwright.invalid/` through `context.route` and proves capture from: the page, `sendBeacon`, a dedicated worker, a sandboxed `srcdoc` iframe, a sandboxed cross-site iframe (out of process), and a worker inside a sandboxed iframe. It also loads a page under a public-looking origin and shows that a sandboxed iframe there still reaches the collector. Updates design §5.2, §9 and §14 with the results.
Acceptance: the test passes on Chromium 1.64.1 with no browser flags.

**P03 Core records.** → P01
ULID IDs with type prefixes, record types from §4, the shared clock helpers, and a JSONL run store that writes `runs/<id>.jsonl` and reads it back.
Acceptance: unit tests for ID format and order, clock conversion, and a JSONL round trip.

**P04 Fixture site.** → P01
`fixtures/site`: a static shop served on `localhost` at a random port. Two more servers on `127.0.0.1` act as a mock server container and an unknown third-party host. `localhost` and `127.0.0.1` are different sites, so these requests are cross-site. It has:
- a consent banner with accept, reject and a "cookie settings" link that reopens it. It grants consent itself, without showing, when the user agent contains `HeadlessChrome`.
- Consent Mode defaults (denied) and updates on choice.
- real gtag.js for `G-PWTEST0001` and `AW-000000001`, and the Meta pixel `000000000000001`.
- a sandboxed iframe at a `/web-pixels@0.0.0-fixture/sandbox/` path that posts to the collector origin and sends a GA4 hit with the sandbox URL as the page.
- a mock Stape loader that requests `/<id>?<key>=<base64>` for `/gtag/js`, `/g/collect` and `/data` (with a base64 `dtdc` payload) from the mock server-container host.
- one request to an unknown third-party destination on the third-party host.
- product, cart, checkout with a delivery-country select, a fake payment form, and a thank-you page that sends a GA4 `purchase` with `user_id`, a Meta `Purchase` and an Ads conversion.
Acceptance: a smoke e2e that loads each page with raw Playwright, stubs Google and Meta collection paths with `context.route`, and sees GA4, Meta, Ads, Stape and collector requests.

### Wave 3

**P05 Decoder interface and GA4.** → P03
`match`, `decode → Hit[]`, `isCollectionEndpoint`. GA4: `en`, `ep.*`, `epn.*`, `tid`, `cid`, `uid` presence, `dl` as page, batched POST bodies (one event per line), `gcs` and `gcd` normalised to `{analytics, ads, adUserData, adPersonalization}` with raw values kept. Page URL check flags sandbox paths.
Acceptance: unit tests from synthetic fixture requests, including a three-event batch, `G100`, `G111` and a `gcd` string.

**P06 Fake identity.** → P03
Seeded identity with Faker (name, email, phone, address, country), normalisation and SHA-256 forms for email and phone, and a leak scanner that finds emails, phones and hashes in decoded text that do not belong to the identity (`possibleRealData`).
Acceptance: the same seed gives the same identity; known hashes match; a foreign email inside a base64 value is flagged.

### Wave 4

**P07 Meta and Google Ads decoders.** → P05
Meta `/tr` GET and POST: `ev`, `id`, `eid`, hashed `ud[*]`. Google Ads: conversion and remarketing pings on googleadservices, doubleclick, googlesyndication and google.com, including `/ccm/collect`.
Acceptance: unit tests from synthetic fixture requests.

**P08 Stape custom loader and sgtm data client.** → P05
Decode `/<id>?<key>=<base64>` to the real path and query, then hand off to the other decoders. Decode `/data` and its base64 `dtdc` payload (event name, `page_location`, `page_hostname`).
Acceptance: unit tests for `/g/collect`, `/data` and `/gtag/js` disguised paths; `/gtag/js` is not a collection endpoint.

**P09 Recorder capture and network modes.** → P02, P03, P04, P05
Chromium launch with a normal Chrome user agent. A fresh context per run. Context-level request and response capture into `Request` and `Response` records. `stub` answers decoder collection endpoints with 204 or a 1×1 GIF and records `outcome: stubbed`. `live` passes everything. Unknown third-party destinations are flagged `unknownDestination`. Collector origin route with schema validation and `invalidReport` records. Init script hooks `dataLayer.push` on the shared clock. Startup self-test reports capture coverage. Verifies the stubbing side effects in §5.3 and updates the design doc.
Acceptance: e2e against the fixture site: no collection request passes in `stub`; the unknown destination is flagged; collector reports are recorded; coverage lists page, iframe and worker.

**P10 Consent package.** → P03, P04
autoconsent driver for a Playwright context: `accept`, `reject`, `none`. Bundled rules plus extra rules from a file, with a rule for the fixture banner. `none` waits for the banner and fails with "banner not shown" if none appears. Consent Mode probe from recorded dataLayer pushes. Epoch builder on the shared clock with a 50 ms grace window.
Acceptance: e2e against the fixture banner for accept, reject and none; a `HeadlessChrome` user agent gives "banner not shown"; unit tests for epochs, including accept then withdraw.

**P11 Expectations.** → P03, P05
Scenario YAML parsing with clear errors. Filters: `vendor`, `event`, `consent.*`, `ids.*`, `page`, `transport`, `host`, `outcome`, `params.*`. Rules: `must`, `mustNot`, `count`, `before: consent`, `in: epoch(<state>)`, `after: <step>`, `identity.hashesMatch`. Built-in checks: `unknownDestination`, sandbox page URL, `possibleRealData`. `Result` records with evidence IDs.
Acceptance: unit tests on synthetic records for every rule and filter, including `ids.user_id` per consent state.

### Wave 5

**P12 Steps.** → P06, P09
`visit`, `click`, `fill` (from the identity), `wait`, `addToCart` (selector), `evaluate`, `checkpoint` (cookies), `handoff`, and a `consent` step that calls the consent package. `Step` records. Payment and password fields can be filled only on loopback hosts, which in practice means the fixture site. On any other host they must be `handoff` steps (design §5.4).
Acceptance: e2e: full fixture checkout through the fake payment form with an explicit delivery country; filling a card field on a non-loopback host fails.

### Wave 6

**P13 Consent in runs.** → P10, P12
Wire the consent step and epochs into runs. `ConsentEpoch` records, and Google hits judged by their own consent values.
Acceptance: e2e for undecided, accept, reject and accept then withdraw: epochs, and consent on each hit.

### Wave 7

**P14 CLI and package.** → P07, P08, P11, P13
`pingwright run <scenario> --site <url> [--network stub|live] [--out runs] [--seed n] [--headed] [--autoconsent-rules file]`. Terminal summary, JSONL output, exit code 1 on any failed expectation. Root bundle and `pnpm pack`.
Acceptance: e2e scenario files in `e2e/scenarios/` for undecided, accept, reject, accept then withdraw, banner not shown, and checkout, run through the CLI. They assert hits, consent per hit, epochs, unknown-destination flagging and `ids.user_id` per consent state. A CI step packs the tarball, installs it into a temp prefix and runs a scenario with it.

### Wave 8

**P15 Docs for 0.1.** → P14
README status and quick start. Design doc: every (verify) claim in 0.1 scope resolved. Version `0.1.0-rc.1`.
Acceptance: docs build nothing; a reviewer checks every 0.1 (verify) claim has a result.

Then tag `v0.1.0-rc.1` on main. No npm publish and no GitHub release.

## (verify) claims

| Claim | Section | Resolved in |
| --- | --- | --- |
| Collector origin works in sandboxed and out-of-process iframes and workers | §9, §14.1 | P02 |
| Dedicated worker capture | §5.2, §14.2 | P02, P09 |
| Stubbing side effects: retries on other transports, tag callbacks | §5.3, §14.3 | P09 |
| Web template sending permission | §8.1, §14.5 | not in 0.1 (0.3) |
| Server template signature APIs | §8.3, §14.4 | not in 0.1 (0.5) |
