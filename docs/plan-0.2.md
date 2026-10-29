# Plan for milestone 0.2

This is the checklist for 0.2. The scope comes from docs/proposal-0.2.md (#120), which was accepted. Each item is one small PR. A PR is done when its acceptance test passes in CI, an Opus review reports no blockers or majors, and it is squash-merged to main.

## The question 0.2 answers

> Here is a GTM change. Run the same scenarios against the published container and against the changed workspace. Show what changed per vendor, event and consent state, and fail if a rule is broken.

## Prerequisites: closed before Wave 1

These proposal items are issue fixes. They must be merged, and released as `0.1.0`, before Wave 1 starts. The proposal named the gate `0.1.0-rc.2`. The maintainer chose to release `0.1.0` itself instead.

| Issue | What | Acceptance (from the proposal) |
| --- | --- | --- |
| #46, #127 | Stape data-client POST is stubbed and decoded | A loader-disguised `POST /data?v=2&event=page_viewed` with a JSON body is `stubbed` and gives an `sgtm` hit with the event name. #127 adds the transport assertion. |
| #114 | `possibleRealData` ignores random IDs and hashed client IDs | A random 64-hex ID and a hashed client ID pass. A foreign email's SHA-256 sent as `em` still fails. |
| #112 | Subdomains of the site are first party | A subdomain request is not `unknownDestination`, and another registrable domain still is. |
| #115 to #118 | Usable output on real sites | As in each issue. |
| #119 | Withdrawal epochs: the `withdrawn` label, defined per signal, and `in: epoch(label=…)` | Proposal §3.1 item 6. |
| #88 | Withdrawal documented | docs/cli.md says how to withdraw. |

Q08 depends on #119, and Q10 depends on #117. Q11 checks that every issue in this table is closed.

## Changes from the proposal

- **Tracker host list.** The proposal suggested DuckDuckGo Tracker Radar as the source of known tracker hosts. Its data is CC BY-NC-SA 4.0, which is non-commercial and share-alike, so Pingwright can't ship it or derive entries from it. Pingwright ships a small curated list in the repo instead, under MIT. Each entry cites the vendor's own public docs. A user can add entries with a list file.
- **Listed trackers become hits.** A request matched by the tracker list gives a minimal hit with the tracker's vendor name. Rules, flags and `diff` then work on it like on any other hit.
- **Preview builds in tests.** Real preview builds need a real container and real credentials, so tests can't use them. A test-only, loopback-only GTM origin points every `gtm.js` fetch at the fixture site. The matcher for `www.googletagmanager.com` still runs in every test (see Q04).

## Package layout

No new packages:

- **`diff`:** the engine in `packages/expect`, the command in `packages/cli`.
- **GTM override:** `packages/recorder`, with the override record in `packages/core` and the flag in `packages/cli`.
- **Pinterest decoder and tracker list:** `packages/decoders`.

## Rules for every PR

The 0.1 rules still hold (docs/plan-0.1.md):

- fake IDs only;
- context-level hooks only;
- a normal Chrome user agent;
- e2e tests against `fixtures/site` in `stub` mode;
- payments and log-ins are handoff steps on any non-loopback host;
- Pingwright never calls the GTM API.

More for 0.2:

- The `gtmAuth` value, in any form, never appears in a record, a log line, an error message or test output.
- The tracker list holds hosts and paths only, never a vendor's code. No entry may be copied from Tracker Radar, EasyPrivacy or Disconnect.
- Each entry says what it touches, so PRs in one wave stay apart.
- New fixture pages are added for new vendors, so existing e2e tests do not change.

## PRs

### Wave 1

**Q01 Record schema version.** Touches: `packages/core`.
`Run.recordSchemaVersion` is an integer. Version 1 is the 0.2.0 record shape, including the fields added in Q04 and Q07. Readers accept a record with no version as version 0, and warn on a version newer than they know. Design §4 documents it.
Acceptance: unit tests for writing, reading, no version, and a newer version.

**Q02 Fixture container builds and loaders.** Touches: `fixtures/site`.
The fixture site serves two GTM container builds, `published` and `workspace`, as small local scripts on its container host at `/gtm.js?id=GTM-PWTEST1`.

How the builds differ:

- `workspace` sends one more GA4 event (`workspace_only`) and drops one Meta event (`AddToCart`).
- `workspace` sets the Consent Mode default for `ad_storage` to granted where `published` denies it, so a paired undecided `page_view` shows a `gcs` change.
- `workspace` deliberately echoes its `gtm_auth` value in a sub-resource URL, in a beacon body and through a page that sends it as `Referer`, so Q04 can test redaction.

How the server answers:

- It serves `workspace` only when `gtm_auth`, `gtm_preview` and `gtm_cookies_win=x` equal the fixture's fake expected values, and 404 otherwise.
- It logs every `gtm_auth` it received, for a positive control.
- A page with the fake ID `GTM-PWNOVER` (no version) returns 404.

New fixture pages load the container three ways:

- a direct `<script src="https://www.googletagmanager.com/gtm.js?id=GTM-PWTEST1">`, which tests route to the fixture;
- a Stape-style custom loader that fetches `gtm.js` as a disguised `/<id>?<key>=<base64>` request to the fixture's server-container host;
- the same loader inside a sandboxed iframe, like a Shopify custom pixel.

The fixture README lists the expected differences.
Acceptance: an e2e with raw Playwright routes `www.googletagmanager.com/gtm.js` to the fixture, loads each page, and sees the published build's hits. It then requests the workspace build with the fake parameters and sees its differences, and requests it without them and gets 404.

**Q03 Curated tracker host list.** Touches: `packages/decoders`.
The list has entries `{vendor, host, paths?, source}`:

- `host` is an exact host or `*.domain`.
- `paths` are path prefixes.
- `source` is an `https` link to the vendor's own docs.

The first vendors are TikTok, Snap, LinkedIn, Microsoft UET, X, Reddit and Criteo. Pinterest gets a full decoder in Q06.

The module exports two functions:

- `trackerFor(request)` returns the entry, or nothing.
- `parseTrackerList(json)` validates a user file with the same schema and gives clear errors.

Acceptance: unit tests for:

- a host match, a path match, a path that must not match, and a library load (the TikTok pixel script) that must not match;
- every entry's `source` is `https` on the vendor's domain;
- validation errors.

### Wave 2

**Q04 GTM override, direct load.** Touches: `packages/core` (`gtmOverride` record), `packages/recorder`, `packages/cli`, `docs/cli.md`.

`--gtm-override <file>` takes the JSON in design §8.2. `container` must match `^GTM-[A-Z0-9]+$`.

The recorder matches requests to `https://www.googletagmanager.com/gtm.js` with `id=<container>`. It ignores other parameters such as `l=`, and does not match another container, `gtag/js` or `ns.html`. It fetches the preview build at `https://www.googletagmanager.com/gtm.js?id=<container>&gtm_auth=<auth>&gtm_preview=<env>&gtm_cookies_win=x` with `route.fetch`, then fulfils the original request with the response. The page's own request URL is never changed.

The test-only GTM origin:

- It comes only from `PINGWRIGHT_TEST_GTM_ORIGIN`.
- It must be an `http://` origin on `127.0.0.1`, `localhost` or `::1`. Any other value is a hard error.
- It is never read from scenario YAML or the override JSON.
- When set, it replaces `https://www.googletagmanager.com` in every `gtm.js` fetch, with or without an override, but not in matching.
- Its use is recorded as `gtmOverride.testOrigin`, and the CLI prints a warning.

The run record:

- `gtmOverride` stores `container`, `gtmPreview`, `gtmAuth: "[redacted]"`, `expectedTags` (stored, not evaluated) and `testOrigin`.
- `gtmOverride.applied` lists each match: `{way: "direct", url, status}`.
- If no request matched, or a preview fetch was not 200, the run fails with exit 2, and the message says which. A 404 says the environment may have no version.

Redaction: the recorder scrubs the `gtmAuth` value, URL-encoded and base64-encoded, from every record it writes. That covers all string fields, including:

- `Request.url`, headers and `postData`;
- `Hit.page` and `Hit.params`;
- `Flag.detail`, `Step.error` and `Result.message`;
- `DataLayerEvent.args` and `InvalidReport.body`;
- CLI text and JSON output, and error messages.

Design §8.2 and §13 are updated.

Acceptance:

- Unit tests:
  - the matcher on real URL shapes;
  - the exact preview fetch URL when no test origin is set;
  - rejection of a non-loopback test origin;
  - container validation.
- E2E through the CLI, with the test origin:
  - a run without the override shows the published build's hits;
  - a run with it shows the workspace build's hits and `applied[0].status: 200`;
  - a container that never loads fails with "no container request matched";
  - `GTM-PWNOVER` fails with the 404 message.
- Positive control: the fixture server's log shows the `gtm_auth` value was sent. Every JSONL line and the CLI output still lack it in plain, URL-encoded and base64 form.

**Q06 Pinterest decoder.** Touches: `packages/decoders`, `fixtures/site` (a new Pinterest page).

It decodes `ct.pinterest.com/v3/` and `/user/` requests, following the documented field layout:

- top-level query: `event`, `tid`;
- the `ed` JSON: event data;
- the `pd` JSON: hashed `em`, presence and raw value;
- the `ad` JSON: `loc` as the page.

It also reads the event ID. Base the fixtures on a redacted capture from the field test, with fake IDs.

In `stub` mode, Pinterest collection paths are stubbed for every resource type, and the library load `s.pinimg.com/ct/core.js` passes. The new fixture page has a fake Pinterest tag that fires before consent on purpose.

Acceptance:

- Unit tests from fixtures for init, pagevisit, addtocart and checkout.
- An e2e on the Pinterest page:
  - every `ct.pinterest.com` collection request is `outcome: stubbed`;
  - `mustNot: { vendor: pinterest, before: consent }` fails;
  - `mustNot: { host: ct.pinterest.com, before: consent }` fails too.

**Q08 Diff engine.** Touches: `packages/expect`. → #119

`diffRuns(a, b)` takes two loaded runs and returns a JSON result.

It pairs hits by a match key: epoch label, vendor, event and step label, plus the page path when `byPage` is set. Inside each key it pairs in time order.

It reports:

- added and removed hits;
- consent changes on paired hits: `gcs`, `gcd` and the normalised fields;
- ID-presence changes;
- keys whose counts differ;
- flag changes per host and kind;
- a warning when `recordSchemaVersion` differs.

Tracker hits from Q07 are hits, so `diff` covers them with no change.
Acceptance: unit tests on synthetic runs for each kind of change, a count mismatch, a withdrawn epoch that does not pair with a first reject, and a version warning.

### Wave 3

**Q05 GTM override through custom loaders.** Touches: `packages/recorder`, `packages/decoders` (an `unwrapStapeLoader()` helper).

`unwrapStapeLoader(request)` returns the decoded inner path and query of a disguised Stape request, or nothing. When the inner request is `/gtm.js?id=<container>`, the recorder answers it with the preview build, as in Q04, and the loader script stays in place.

- The record stores `applied: {way: "loader", loader: "stape", url, status}`.
- It also stores `loses: "nothing known; the loader script runs unchanged"`.

Fallback: `loader: {replace: "<script URL>"}` in the override JSON replaces that loader script with the preview build. The record stores `way: "replace"` and `loses: "everything the loader does beyond fetching the container"`.

Way 2, passing the values through the loader, is not built.

Acceptance:

- E2E through the CLI, for the Stape-style loader on the page and inside a sandboxed iframe. Each shows the workspace build's hits and `way: "loader"`, and passes the Q04 redaction check.
- An e2e for the `replace` fallback.
- Unit tests for `unwrapStapeLoader`.

**Q10 Shopify checkout pattern.** Touches: `fixtures/site` (checkout hashes), `docs/shopify-checkout.md`, `e2e/scenarios`. → #117

The fixture's Meta `Purchase` sends `ud[em]` with the SHA-256 of the email typed at checkout. GA4 `purchase` sends `user_data` with the same hash.

docs/shopify-checkout.md is a pattern:

1. product;
2. add to cart (checked, per #117);
3. checkout;
4. fill with the fake identity;
5. set the delivery country explicitly;
6. a `handoff` step for payment;
7. a labelled thank-you step;
8. `identity.hashesMatch` on the purchase hits.

On hosted stores this is a field-run pattern, because the handoff needs a person.

Acceptance:

- The hosted variant's YAML parses in a unit test.
- The fixture variant fills and clicks `#pay`, which design §5.4 allows on loopback. It runs in an e2e through the CLI, where `identity.hashesMatch` passes.
- A variant with a wrong hash fails.

### Wave 4

**Q07 Stub known tracker hosts.** Touches: `packages/decoders` (a `tracker` decoder), `packages/recorder` (stub rule), `packages/expect` (vendor keys), `packages/cli` (`--tracker-list`), `fixtures/site` (a new tracker page).

The `tracker` decoder turns a request matched by `trackerFor` into a minimal hit:

- `vendor` is the entry's vendor name;
- `event` comes from a common event parameter when present, otherwise `null`;
- `page` comes from a common page parameter or the frame URL;
- `params` is empty;
- consent is `unknown`, so the epoch fallback applies;
- `transport: "tracker-list"`.

Tracker vendors are valid `vendor:` keys. Listed tracker requests are not raised as `unknownDestination`.

Stub rule:

- An entry with `paths` stubs those paths for every resource type, including script (JSONP) and document (iframe pixel) requests.
- An entry for a whole host stubs data-carrying requests other than script, stylesheet, font and document loads.
- Library loads pass.

`--tracker-list <file>` adds entries, with the Q03 schema and validation. docs/cli.md is updated.

Acceptance, as e2e on the new tracker page:

- A TikTok-style pixel request is `stubbed`, and `{ vendor: tiktok, before: consent }` and `{ host: <host>, before: consent }` both match it in a failing `mustNot`.
- The TikTok pixel script load passes.
- A Criteo-style collection sent as a script request to a listed path is `stubbed`.
- A tracker from a user list file is stubbed.
- `diff` of two runs shows a tracker hit that one run has and the other lacks.

### Wave 5

**Q09 `pingwright diff` command.** Touches: `packages/cli`, `docs/cli.md`. → Q08, Q04

`pingwright diff <a.jsonl> <b.jsonl> [--by-page] [--json]` gives a text summary grouped by epoch label, then vendor, then event. It always exits 0.

Acceptance: an e2e records two runs of the same scenario through the recorder API with the test GTM origin, one with the workspace override and one without, then runs `pingwright diff` through the CLI. The diff shows:

- the added `workspace_only` GA4 event;
- the removed Meta `AddToCart`;
- the `gcs` change on the paired undecided `page_view`.

**Q11 Docs and version for 0.2.0-rc.1.** Touches: README, `docs/`, root `package.json` and the recorder's version source (#111).

This PR:

- updates the README: what 0.2 covers, an override and diff quick start, and the tracker list;
- marks 0.2 built in design §15 and adds a §15.2 "Differences in 0.2";
- marks each PR in this plan with its number;
- checks every prerequisite issue is closed;
- sets the version to `0.2.0-rc.1` in every place the version lives.

Acceptance: an Opus review checks the docs against the code. Every (verify) claim below has a result.

Then run `scripts/release.sh 0.2.0-rc.1` on main and push the tag. Then do the field-run checklist in proposal §5 with the maintainer.

## (verify) claims

| Claim | Where | Resolved in |
| --- | --- | --- |
| A request from inside a sandboxed iframe can be answered with a preview build fetched by `route.fetch` | proposal item 1 | Q05 |
| Stape custom loaders forward `gtm_auth` and `gtm_preview` | proposal §6 | not built in 0.2 (way 2); field question |
