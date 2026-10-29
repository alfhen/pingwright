# Plan for milestone 0.2

This is the checklist for 0.2. The scope comes from docs/proposal-0.2.md (#120), which was accepted. Each item is one small PR. A PR is done when its acceptance test passes in CI, an Opus review reports no blockers or majors, and it is squash-merged to main.

## The question 0.2 answers

> Here is a GTM change. Run the same scenarios against the published container and against the changed workspace. Show what changed per vendor, event and consent state, and fail if a rule is broken.

## Already done before 0.2

These items were in the proposal. They shipped in 0.1.0 as issue fixes:

- the checks that failed on every real run (proposal item 5: #46, #112, #114);
- usable output on real sites (item 8: #115 to #118);
- withdrawal epochs (item 6, #119): the `withdrawn` label, defined per signal, and the `in: epoch(label=…)` selector.

## Changes from the proposal

- **Tracker host list.** The proposal suggested DuckDuckGo Tracker Radar as the source of known tracker hosts. Its data is licensed CC BY-NC-SA 4.0, which is non-commercial and share-alike, so it can't ship inside MIT Pingwright. 0.2 ships a small curated list in the repo instead, under MIT. Each entry cites the vendor's public docs. A user can add hosts, or point to a list file of their own, including a local copy of Tracker Radar under its license.
- **Preview builds in tests.** Real preview builds from `www.googletagmanager.com` need a real container and real credentials, so tests can't use them. The fixture site serves two container builds, and a test-only option points the override at the fixture's container host. Real runs always fetch from `www.googletagmanager.com`.

## Package layout

No new packages:

- **`diff`:** the engine lives in `packages/expect`, which the README lists as "scenario and expectation format, run diffs". The command lives in `packages/cli`.
- **GTM override:** the recorder in `packages/recorder`, with the override record in `packages/core`.
- **New decoder and tracker list:** in `packages/decoders`.

## Rules for every PR

The 0.1 rules still hold (docs/plan-0.1.md):

- fake IDs only;
- context-level hooks only;
- a normal Chrome user agent;
- e2e tests against `fixtures/site` in `stub` mode;
- payments and log-ins are handoff steps on any non-loopback host;
- Pingwright never calls the GTM API.

Two more for 0.2:

- `gtmAuth` and any `gtm_auth` value never appear in a record, a log line or test output.
- The curated tracker list contains hosts and paths only, never a vendor's code or data.

## PRs

Arrows show dependencies. PRs in the same wave touch different packages and can run in parallel.

### Wave 1

**Q01 Record schema version.** → none
`Run.recordSchemaVersion` is an integer, starting at 1. Writers set it, and readers accept records with no version as version 0. Design §4 documents it.
Acceptance: unit tests for writing, reading and a record without a version.

**Q02 Fixture container builds and loaders.** → none
The fixture site serves two GTM container builds, `published` and `workspace`, as small local scripts. The `workspace` build sends one more GA4 event and drops one Meta event. Both are reachable three ways:

- a direct `gtm.js?id=GTM-PWTEST1` load from the fixture's container host;
- a Stape-style custom loader that fetches `gtm.js` as a disguised `/<id>?<key>=<base64>` request;
- the same loader running inside a sandboxed iframe, like a Shopify custom pixel.

The fixture README lists the expected differences. Fake container ID only.
Acceptance: an e2e with raw Playwright loads each variant and sees the hits of the published build.

**Q03 Curated tracker host list.** → none
In `packages/decoders`, a list of known collection hosts and paths for vendors with no decoder. Each entry has a vendor name, a host, optional path prefixes and a source link. Start with Pinterest, TikTok, Snap, LinkedIn, Microsoft UET, X, Reddit and Criteo. Export a lookup `trackerFor(request)`.
Acceptance: unit tests for a match, a path that must not match, and a library load (such as the TikTok pixel script) that must not match.

### Wave 2

**Q04 GTM override, direct load.** → Q02
`--gtm-override <file>` takes the JSON in design §8.2. The recorder rewrites the `www.googletagmanager.com/gtm.js?id=<container>` request to the preview build, adding `gtm_auth`, `gtm_preview` and `gtm_cookies_win=x`. It fetches the build with `route.fetch` and fulfils the request with the response. The run stores `gtmOverride` with `gtmAuth` as `"[redacted]"`.

Redaction covers:

- `gtm_auth` in every recorded URL;
- headers, including `Referer`;
- request bodies;
- the CLI's text and JSON output.

`expectedTags` is stored but not evaluated. Design §8.2 and §13 are updated.
Acceptance: e2e against the fixture: a run with the override shows the workspace build's hits, and one without shows the published build's. A test reads every line of the JSONL and the CLI output and finds no `gtmAuth` value.

**Q05 GTM override through custom loaders.** → Q04
This adds proposal item 1, way 1: when the `stape-custom-loader` decoder decodes a request to `/gtm.js?id=<container>`, the recorder answers it with the preview build, and the loader script stays in place. Way 3 is a fallback option, `override.loader: replace`, which replaces a configured loader script URL with the preview build. The run record states the way used and what it may lose. Way 2 (passing values through the loader) is not built.
Acceptance: e2e for the fixture's Stape-style loader on the page and inside a sandboxed iframe. Both show the workspace build's hits and record way 1. The fallback has a unit test.

**Q06 Pinterest decoder.** → Q03
`ct.pinterest.com/v3/` and `/user/` requests: event, `tid`, page (`ad.loc` or `url`), event ID, hashed `em` presence and raw value. Pinterest hosts are stubbed in `stub` mode, and their library load (`s.pinimg.com/ct/core.js`) passes. The fixture site gets a fake Pinterest tag.
Acceptance: unit tests from synthetic fixtures for init, pagevisit, addtocart and checkout. An e2e rule `mustNot: { vendor: pinterest, before: consent }` fails on the fixture, because its Pinterest tag fires before consent on purpose.

**Q07 Stub known tracker hosts.** → Q03
In `stub` mode, the recorder also stubs data-carrying requests to hosts from `trackerFor`, other than script, stylesheet, font or document loads. They are recorded as `outcome: stubbed` with `tracker: <vendor>`. Library loads pass. Expectations can filter on `tracker` and on `host`. Scenario option `trackerHosts` adds entries, and `--tracker-list <file>` loads extra entries from a file.
Acceptance: e2e: a fixture page sends a TikTok-style pixel request with no decoder. The request is `stubbed`, a rule `{ tracker: tiktok, before: consent }` matches it, and the pixel's script load passes.

**Q08 Diff engine.** → Q01
In `packages/expect`, `diffRuns(a, b)` takes two loaded runs. It groups hits by epoch label, vendor and event. It pairs them by the match key (epoch label, vendor, event, step label, plus the page path when `byPage` is set), in time order inside a key. It reports:

- added and removed hits;
- consent changes on paired hits (`gcs`, `gcd`, normalised fields);
- ID presence changes;
- keys whose counts differ;
- flag changes per host and kind;
- a warning when `recordSchemaVersion` differs.

Pure function, JSON result.
Acceptance: unit tests on synthetic runs for each kind of change, a count mismatch and a version warning.

### Wave 3

**Q09 `pingwright diff` command.** → Q08, Q04
`pingwright diff <a.jsonl> <b.jsonl> [--by-page] [--json]` gives a text summary grouped by epoch label, then vendor, then event. It always exits 0. docs/cli.md is updated.
Acceptance: e2e: two CLI runs against the fixture, one with the workspace override. The diff shows the known added GA4 event, the known removed Meta event, and a consent change on a paired hit, in a scenario that accepts in one run and rejects in the other.

**Q10 Shopify checkout pattern.** → Q04
docs/shopify-checkout.md is a scenario pattern:

1. product;
2. add to cart;
3. checkout;
4. fill with the fake identity;
5. set the delivery country explicitly;
6. a `handoff` step for payment;
7. a labelled thank-you step;
8. `identity.hashesMatch` on the purchase hits.

On hosted stores this is a field-run pattern, because the handoff needs a person. The fixture variant pays on localhost and runs in CI.
Acceptance: an e2e runs the fixture variant through the CLI, and the handoff step completes through the test resolver. The doc's YAML parses in a unit test.

### Wave 4

**Q11 Docs and version for 0.2.0-rc.1.**
This PR updates:

- README: what 0.2 covers, an override and diff quick start, and the tracker list.
- Design §8.2, §11, §13 and §15: the milestone list from the proposal.
- docs/plan-0.2.md: each PR is marked done.

It sets the version to `0.2.0-rc.1`.
Acceptance: an Opus review checks the docs against the code. Every new (verify) claim has a result.

Then run `scripts/release.sh 0.2.0-rc.1` on main and push the tag. Then do the field-run checklist in proposal §5 with the maintainer.

## (verify) claims

| Claim | Where | Resolved in |
| --- | --- | --- |
| A `route.fetch` from inside a sandboxed iframe's request can be fulfilled with a cross-origin preview build | proposal item 1 | Q05 |
| Stape custom loaders forward `gtm_auth` and `gtm_preview` | proposal §6 | not built in 0.2 (way 2); field question |
