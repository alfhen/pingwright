# Changelog

## 0.6.0-rc.1

<!-- E01 -->

<!-- N06 -->

<!-- W06 -->

- A suite verdict names a built-in check that failed in a run unless that run's own report already named it. A stores file now refuses a rules file that exists but cannot be read.

<!-- M04 -->

<!-- M10 -->

<!-- M11 -->

<!-- E02 -->

<!-- L06 -->

<!-- H06 -->

<!-- E03 -->

<!-- D01 -->

<!-- E05 -->

<!-- E04 -->

<!-- E06 -->

<!-- R06 -->

## 0.5.0

`npm i -g tagreeve` installs this release. 0.5.0 adds everything in the 0.4.0 and 0.5.0 release candidates (below) and the changes under "Since rc.2". To upgrade from 0.3.0, read the next section.

### What 0.5.0 adds

- Server container: `--server-container` runs your own server container in Docker and records every call it makes to a vendor. Those calls are decoded and checked like browser hits. A hit rule can select by sender with `sentBy`. The guide shows how to test an unpublished server workspace through its preview environment.
- Checks and rules: the `meta-capi` decoder, the `earlyIdentifiers` check, `from:` on hit and cookie rules, `identity.hashesMatch` over every value of a Conversions API field, and a stricter `unloadGap`.
- Steps and runs: handoff steps that end by themselves, the opt-in `payment` step for a provider's test card, `--viewport`, and fake identities by country.
- Several runs: `tagreeve suite --stores` runs each scenario against several stores, and `tagreeve baseline save` with `run --baseline` catches drift in the shape of a run.
- Output: summaries show query names only and mask value-like path segments, and every command has its own `--help`.

### Upgrading from 0.3.0

- **The package and the command have a new name.** Uninstall the old package, then run `npm i -g tagreeve`, in this order. The steps are in the 0.4.0-rc.1 section below. The command is `tagreeve`. The old command alias is gone.
- **Environment variables and the config folder.** Variables start with `TAGREEVE_`. The config folder is `$XDG_CONFIG_HOME/tagreeve/`, else `~/.config/tagreeve/`.
- **Record schema version 3.** Records from 0.3.0 still read. A 0.3 reader warns on a version 3 record. Records keep the key `pingwrightVersion`.
- **`suite.json` is version 2.** `report` reads versions 1 and 2.
- **Requests to Shopify infrastructure hosts** (`cdn.shopify.com`, `monorail-edge.shopifysvc.com`) are flagged `platformHost` and no longer fail the `unknownDestination` check. Set `options.platformHosts: false` to get the old behaviour.
- **A run can show a new warning.** `earlyIdentifiers` is `warn` by default. It does not change the exit code unless you set it to `fail`.
- **`identity.hashesMatch` is stricter.** It checks every value of a Conversions API `em` or `ph`, and a plain `ct`, `zp` or `country` on such an event fails the check, so a rule that passed can now fail.
- **`--by-page` keys change.** Path segments that look like a value read `*`. A `--by-page` baseline saved on a page with such a segment drifts once. Save it again.
- **Summaries show less.** The text and `--json` summaries show a flag's request with query names only. Records keep the full detail.

### Since rc.2

- `sentBy: browser` or `sentBy: server` in a hit rule selects hits by sender. A browser-only `mustNot` on a Google host no longer fails on the server container's own forwarding with `--server-container` (#900, #902).

- Fix: when the `tagreeve-sgtm` server container image is missing, the message lists the local `tagreeve-sgtm` tags, or says `none`. `suite --server-container` stops with exit 2 before any scenario starts (#898).

- The text and `--json` summaries no longer print a value from a flag's URL. A relative or protocol-relative URL is redacted like an absolute one, a path segment that looks like a value reads `(other)`, and a bare query item reads `(other)`. Records are unchanged (#870, #871, #869, #874, #853).

### Known in 0.5.0

Issues still open that you can meet:

- `--server-container` needs Docker. The container downloads its configuration from Google at every start, so a run needs the network for three Google paths, and Google sees the container's request with your `gtm_auth`.
- The local container is Google's image. Stape-only features are missing: the custom loader and its domain features, Cookie Keeper, the geo and bot headers Stape adds, store ID headers, request logs and the CDN. With the live config it serves the published version. To test an unpublished server workspace, use a config from its preview environment (see the server container guide).
- Sends from `pagehide` or `visibilitychange` are answered in the page, also to your `serverHosts`, so the container never gets them. A purchase sent at unload shows no server rows (#816).
- The Meta Conversions API, Pinterest and Criteo template tags are not yet proven to reach the recording proxy.
- Link rule 2 (a link by client ID and event name) is not built. Links between container calls and browser hits are exact by event ID only. A leak through a container call with no event ID, such as the built-in GA4 tag, links at best as probable, so it is only a warning (#901).
- The Shopify platform-host list holds only `cdn.shopify.com` and `monorail-edge.shopifysvc.com`. Other Shopify telemetry, checkout and payments hosts stay `unknownDestination` (#585). Turning `options.platformHosts` off flags those two hosts as `unknownDestination` again, which fails the run (#886).
- The `payment` step is not confirmed on a real Shopify checkout. The test-mode marker on the page, the expiry format and the card frame paths are inferred. If one does not match, the step fails closed and the error names the frame path and the inputs' attributes. A required terms checkbox at checkout is not covered by the step (#810).
- The payment step checks the card host before each short fill try. That narrows the window in which typing could go to another host but cannot close it, because Playwright cannot check the host and type in one step (#845).
- The body scan can still merge two values when the shorter one occurs only in encoded form, so the count and place list are wrong. The request is still flagged (#848).
- A plain `ct`, `zp` or `country` that does not match on a Conversions API event is reported as hashed (#850).
- A hit from a redirect hop has no frame id and still matches by frame URL (#879).
- The suite verdict can hide a check's failure in a run with no leak when another run named a leak (#822).
- Records keep the full flag detail, including query values. Do not share a record from a page that sends an identifier in a query.
- The `sandboxPageUrl` message does not mask a path segment of a relative page that holds a space (#920). A flag text for `unloadGap` can be cut short when a dataLayer event name holds `: /` (#918).
- The server container guide's encode steps can leave an editor backup or swap file with the plain auth string. Delete such files with `plain.txt` (#913).
- `earlyIdentifiers` is `warn` by default.
- Playwright's request interception sometimes misses a redirect hop. The `possibleRedirectHop` flag marks a likely miss in `stub` and `server` mode. `live` mode has no such flag.
- With `--net-log`, requests seen only in the net log are labelled by timing, and an early `srcdoc` iframe request can still read `unload`.
- `unloadGap` compares dataLayer event names to hit names literally, apart from the GA4 aliases.
- `--viewport` takes `<W>x<H>` only. A `mobile` preset is not built.
- `identity.country` has local formats for US, SE, GB and DE. Other countries keep US-shaped data and the run warns.
- The tag-firing reporter templates, `expectedTags` and `tagreeve init` are planned for 0.6.0.
- The node-forge bump (#719) waits until node-forge 1.4.2, published 2026-10-27, is two weeks old, so it lands on or after 2026-11-10.

The other open `review-minor` issues are open in the 0.6.0 milestone. They are test gaps, wording and edge cases.

## 0.5.0-rc.2

Release candidate. Install it with `npm i -g tagreeve@next`.

- The `payment` step finds each Shopify card field by its `name` or `autocomplete` and its frame by document path. A frame with the right title but another path is skipped. When the input count is not 1, the error lists the frame path and the `name`, `autocomplete` and `type` of each visible input (#788, #684, #691).

- Fix: a server container call made up to one second after a handoff closes is stored without its body and query values. A container call is no longer sent an empty `Cookie` header when the browser sends none (#772, #768).

- Fixes in the body scan: two different values no longer merge into one finding when one contains the other, a JSON path of digits is no longer read as a phone number, a part typed as binary in a text body is named by its field, and a body of over 100,000 values no longer overflows the stack. (#667, #668, #669, #670, #673)

- `identity.hashesMatch` checks every value of a Conversions API `em` or `ph`. Further values are hit params `hashedEmail.1`, `hashedEmail.2` and so on. A filter on `ids.hashes.<field>.matchesIdentity` is computed from the run identity on a `meta-capi` hit; the record keeps null. Every further value of `fn`, `ln`, `ct`, `zp` and `country` is checked too, and a plain `ct`, `zp` or `country` on a Conversions API event fails the check. (#712, #714, #715, #808)

- An unknown option now prints one line, `Unknown option --bogus.`. `tagreeve <command> --help` prints the options of that command for every command. A mistyped option before the command keeps the command name in the usage hint.

- `suite --stores` now exits 2 when `--allow-test-payment` matches no store and a payment scenario would run. A stores file whose `autoconsentRules` file is missing is rejected when the file is read.

- `diff --by-page` and `baseline save --by-page` now mask a path segment that holds `@`, a percent-encoded byte, an email, a phone number or a hash. `diff` treats `platformHost` flag changes as allowed and hides them unless `--all-flags` is given. The docs list the masking rules in full. (#705, #706, #743)

- The verdict names a failed `deniedIdentifiers` check when only early identifiers are named, and an `earlyIdentifiers` warning when only denied identifiers are named. Each check is hidden only when its own findings are already in the sentence (#663, #805).

- Fix: the text and `--json` summaries show a flag's request with query names only, never values (`?a&b`). A query name that looks like a value reads `(other)`. The `sandboxPageUrl` message names the page by host and path. Records keep the full flag detail otherwise. Path segments are not masked yet. (#679, #801)

- `unloadGap` now matches a GA4 hit to a push by frame document, not by frame URL. Two `about:srcdoc` frames, or two frames with one URL, no longer cover each other (#723, #722, #724, #725).

- The recording proxy refuses every spelling of the unspecified address (`::0`, `0`, `0:0:0:0:0:0:0:0`), and checks the address it bound. `tagreeve server-container build` on arm64 now says Docker is needed when the Docker daemon does not answer (#718, #791).

- Adds `from: <step label>` to hit and cookie rules. The window starts at the labelled step's start, so a visit step's own page-load hits count. `after:` still starts at the step's end. A rule with both is a scenario error. (#789, #806)

### Known in 0.5.0-rc.2

Issues still open that you can meet:

- `--server-container` needs Docker. The container downloads its configuration from Google at every start, so a run needs the network for three Google paths, and Google sees the container's request with your `gtm_auth`.
- The Meta Conversions API, Pinterest and Criteo template tags are not yet proven to reach the recording proxy. Check C0, items 1 to 3, runs in the rc.2 field test.
- Link rule 2 (a link by client ID and event name) is not built. Links between container calls and browser hits are exact by event ID only. A leak through a container call with no event ID, such as the built-in GA4 tag, links at best as probable, so it is only a warning (#783).
- The Shopify platform-host list holds only `cdn.shopify.com` and `monorail-edge.shopifysvc.com`. Other Shopify telemetry, checkout and payments hosts stay `unknownDestination` (#585).
- The fix for the Shopify card fields (#788) is not yet confirmed on a real checkout. The rc.2 field test confirms it. If it fails, the error names the frame path and the inputs' attributes.
- The payment step checks the card host before each short fill try. That narrows the window in #691 but cannot close it, because Playwright cannot check the host and type in one step (#845).
- A flag's detail keeps query values in records. The text and `--json` summaries show query names only, except a `sandboxPageUrl` page that is not an absolute URL, which keeps its query (#679, #782, #870). Path segments are not masked in flag detail (#871).
- A bare query item with no `=` is shown as a name unless it looks like a value (#869).
- A hit from a redirect hop has no frame id and still matches by frame URL (#879).
- The suite verdict can hide a check's failure in a run with no leak when another run named a leak (#822).
- Stape-only features do not exist in the local container, which is Google's image: the custom loader and its domain features, Cookie Keeper, the geo and bot headers Stape adds, store ID headers, request logs and the CDN. Unpublished server workspaces are not available either.
- `earlyIdentifiers` is `warn` by default.
- Playwright's request interception sometimes misses a redirect hop. The `possibleRedirectHop` flag marks a likely miss in `stub` and `server` mode. `live` mode has no such flag.
- With `--net-log`, requests seen only in the net log are labelled by timing, and an early `srcdoc` iframe request can still read `unload`.
- `unloadGap` compares dataLayer event names to hit names literally, apart from the GA4 aliases.
- `--viewport` takes `<W>x<H>` only. A `mobile` preset is not built.
- `identity.country` has local formats for US, SE, GB and DE. Other countries keep US-shaped data and the run warns.
- The tag-firing reporter templates, `expectedTags` and `tagreeve init` are planned for 0.6.0.
- The node-forge bump waits until the release is two weeks old, on 2026-11-10 (#719).

The other open `review-minor` issues are in the 0.5.0 milestone.

## 0.5.0-rc.1

Release candidate. Install it with `npm i -g tagreeve@next`.

### Added

- Adds a `meta-capi` decoder for Meta Conversions API calls (`graph.facebook.com/v<n>/<id>/events`). One hit for each event in `data`. In `stub` mode the endpoint is answered with a success body. Part of #358.

- `tagreeve suite <dir> --stores <stores.json>` runs each scenario against several stores. Cells carry `labels.store`, records are named `<scenario>.<store>.<variant>.jsonl`, and diffs compare variants within a store. `suite.json` is now version 2 and adds `stores` and `SuiteDiff.store`. `report` reads version 1 and 2. A payment scenario runs only for the store that `--allow-test-payment` names. (#360)

- Requests to `cdn.shopify.com` and `monorail-edge.shopifysvc.com` are flagged `platformHost` instead of `unknownDestination`, so they no longer fail the `unknownDestination` check. They are still listed in the summary and the report. Set `options.platformHosts: false` to restore the old behaviour. (#585)

- Adds `tagreeve server-container build`, which builds the Docker image for the coming server container feature (arm64 builds locally from Google's image, pinned by digest; amd64 needs no build). Adds the runner, the per-run `--internal` network, the relay and egress probe, the owner-labelled sweep and a stand-in container for tests. Tagreeve never pushes an image. Part of #358.

- Adds `--server-container` and `--server-container-config` to `run` and `suite`. Tagreeve runs your own server container in Docker, sends the non-load requests to your `serverHosts` to it, and records every call it makes to a vendor. The calls are decoded and checked like browser hits and answered locally. Nothing is sent on, except three Google requests the container needs to load its configuration. A hit from the container links to a browser hit with `Hit.via`. Record schema version 3. Part of #358.

- A hit that the server container sent on is judged by the browser hit it links to, for `before`, `in: epoch(...)`, `after`, `deniedIdentifiers` and `earlyIdentifiers`, and in `diff` and `baseline`. Only an exact link can fail a run: a failure that rests on a probable link is a warning with the note `serverSendProbableLink`, and a hit with no link is `cannot evaluate` with the note `serverSendUnlinked`. The summary has a `Server container` line and `--json` has `serverContainer`. The report shows server vendors as their own rows. Part of #358.

### Changed

- The release workflow test is stricter: it checks job permissions, publish lines, `github.token` and docker pushes. (#546)

- `--by-page` keys now replace path segments that look like a value, such as a checkout token, with `*`. A `--by-page` baseline saved on a page with a token drifts once. Save it again.

### Fixed

- `unloadGap` now also warns when an embedded frame pushed a tracking event shortly before the run ended (browser close), not only before a navigation (#261, #550).
- A GA4 hit sent from the same frame as the push now covers the event, whatever its custom name, so custom event names no longer give a false `unloadGap` (#261, #550).
- The `/unload-gap?mode=` fixture page writes the mode into the iframe `src` on the server (#552).

### Removed

- The old command alias. Use `tagreeve`. (#546)

### Known in 0.5.0-rc.1

Issues still open that you can meet:

- `--server-container` needs Docker. The container downloads its configuration from Google at every start, so a run needs the network for three Google paths, and Google sees the container's request with your `gtm_auth`. That is what your container does in production too.
- The Meta Conversions API, Pinterest and Criteo template tags are not yet proven to reach the recording proxy, and links between container calls and browser hits are exact by event ID only. The rc.1 field test runs these checks (Check C0, items 1 to 3).
- The Shopify platform-host list holds only the hosts that a Shopify docs page names, so far `cdn.shopify.com` and `monorail-edge.shopifysvc.com`. Other Shopify telemetry, checkout and payments hosts stay `unknownDestination` (#585).
- Stape-only features do not exist in the local container, which is Google's image: the custom loader and its domain features, Cookie Keeper, the geo and bot headers Stape adds, store ID headers, request logs and the CDN. Unpublished server workspaces are not available either. The container loads a published version or a named environment.
- A container call forwarded just after a handoff closes is not redacted (#772). The container gets all request headers, not only `Cookie` (#769), and an empty `Cookie` header when the browser has none (#768).
- `platformHost` flags are not allowed in `diff`, so `diff` and `suite` show more noise than `run` (#743).
- `--allow-test-payment` with a host that matches no store skips every payment cell without a message (#735).
- A missing `autoconsentRules` file is found only when each run starts (#737).
- Only the first value of a multi-value `em` or `ph` on a Conversions API event is kept and checked (#712). Plaintext `ct`, `zp` and `country` on such an event pass `identity.hashesMatch` (#715), and `ids.hashes.<f>.matchesIdentity` is always null on `meta-capi` hits (#714).
- `--by-page` keys keep email-shaped and percent-encoded value segments (#705).
- A frame URL is not a frame identity, so a hit from another frame with the same URL can cover a push (#723).
- The Shopify payment runtime is not yet checked on a real checkout. The test-mode marker, the card input selector and the expiry format are unconfirmed (#695, #648). A supervised field test runs it with a declared host. If a value does not match, the step fails closed and says why.
- `earlyIdentifiers` is `warn` by default.
- The `--json` summary flags (`unknownDestination`, `firstPartySubdomain`, `stubBypass`, `possibleRedirectHop`) carry the full request URL, including query values. Do not share the summary from a page that sends an identifier in a query (#679).
- The verdict can hide a failed `deniedIdentifiers` when only early identifiers are named (#663).
- A text part of a multipart body that is typed as binary is reported `in the body`, not by its field name (#669).
- A mistyped option before the command loses the command name in the usage hint (#657), and the hint can name the wrong command (#644). Most per-command `--help` prints the general usage (#641). The unknown-option line is very long (#640).
- The possible-real-data check merges two different emails or two different phones when one contains the other, so the count and the place are wrong (#667). A number prefix in a JSON path can be flagged as a phone (#668). The binary-share check counts UTF-16 units, not code points (#673). A body with about 100k or more leaf texts overflows the stack (#670).
- Playwright's request interception sometimes misses a redirect hop (#180). The `possibleRedirectHop` flag marks a likely miss in `stub` and `server` mode. `live` mode has no such flag.
- With `--net-log`, requests seen only in the net log are labelled by timing, and an early `srcdoc` iframe request can still read `unload` (#256).
- `unloadGap` compares dataLayer event names to hit names literally.
- `--viewport` takes `<W>x<H>` only. A `mobile` preset is not built (#514).
- `identity.country` has local formats for US, SE, GB and DE. Other countries keep US-shaped data and the run warns.
- The tag-firing reporter templates, `expectedTags` and `tagreeve init` are planned for 0.6.0.

Other open `review-minor` issues are test gaps, wording, or edge cases with no effect on a normal run. They carry the `review-minor` label.

## 0.4.0-rc.3

Release candidate. Install it with `npm i -g tagreeve@next`.

### Changes
- The `payment` step now types into the exact card iframe that it checked. It skips hidden duplicate frames and frames served from another host, and uses the one visible input in the frame. If several visible inputs match, it fails with the count instead of guessing. A fill error now keeps its reason: `card field number could not be filled: <reason>`, with typed values removed. `card frame not found` also says why. This targets the Shopify Payments failure in the rc.2 field test; it is not confirmed on a real store. (#682, #648)

- The declaration hint after `test mode not detected` names the provider of the `payment` step that failed. It appears only when the allowlist file would accept the entry, so it no longer suggests the `fixture` provider on a hosted host or a loopback host without the test seam. The declared-payment e2e now checks that a run prints no email, email hash or cookie value. (#646, #647, #649)

### Known in 0.4.0-rc.3

Issues still open that you can meet:

- The Shopify payment runtime is not yet checked on a real checkout. The card input selector (`input`, narrowed to the visible inputs in the verified frame), the expiry format (`12/40` against a masked "MM / YY" field) and the root cause of the rc.2 failure (#682) are still not confirmed. A supervised field test runs it with a declared host. If a value does not match, the step fails closed and the error now says why.
- `earlyIdentifiers` is `warn` by default. The field test decides whether it becomes `fail` for 0.4.0.
- The `--json` summary flags (`unknownDestination`, `firstPartySubdomain`, `stubBypass`, `possibleRedirectHop`) carry the full request URL, including query values. Do not share the summary from a page that sends an identifier in a query (#679).
- The verdict can hide a failed `deniedIdentifiers` when only early identifiers are named (#663).
- A text part of a multipart body that is typed as binary is reported `in the body`, not by its field name (#669).
- A mistyped option before the command loses the command name in the usage hint (#657), and the hint can name the wrong command (#644). Most per-command `--help` prints the general usage (#641). The unknown-option line is very long (#640).
- The possible-real-data check merges two different emails or two different phones when one contains the other, so the count and the place are wrong (#667). A number prefix in a JSON path can be flagged as a phone (#668). The binary-share check counts UTF-16 units, not code points (#673).
- Playwright's request interception sometimes misses a redirect hop (#180). The `possibleRedirectHop` flag marks a likely miss in `stub` and `server` mode. `live` mode has no such flag.
- With `--net-log`, requests seen only in the net log are labelled by timing, and an early `srcdoc` iframe request can still read `unload` (#256).
- `unloadGap` compares dataLayer event names to hit names literally (#261).
- `--viewport` takes `<W>x<H>` only. A `mobile` preset is planned for 0.5.0 (#514).
- The leak check misses a URL-encoded email (#565).
- Platform infrastructure hosts fill the `unknownDestination` list (#585).
- A gap frame is requested twice when `mode` is given (#552).
- `identity.country` has local formats for US, SE, GB and DE. Other countries keep US-shaped data and the run warns.
- No test covers a suite child without `suite.json` beside a valid one (#593). The cookie already-set e2e leak check skips the report (#543).
- Server-to-vendor traffic is not visible to Tagreeve (#358), and several stores in one suite (#360) is planned. Both are deferred to 0.5.0.

Other open `review-minor` issues are test gaps, wording, or edge cases with no effect on a normal run. They carry the `review-minor` label.

## 0.4.0-rc.2

Release candidate. Install it with `npm i -g tagreeve@next`.

### Changes
- The built-in check `earlyIdentifiers` warns when a hit sent before the first consent answer carries an identifier, such as a hashed email, and its consent signal is unknown. It is `warn` by default, so no exit code changes. Set `options.builtins: { earlyIdentifiers: fail }` to fail a run. The report marks such a hit `leak` with the label `identifiers sent before an answer`, and the verdict names the vendors. A hit with only `fbp` or `cid` is not flagged. (#626, #627)

- A host in the test payment allowlist can declare its test mode: `{ "host": "shop.example.com", "testMode": "shopify-test" }`. A declared host needs no marker on the page. Without a declaration, the marker must now sit inside the card form. The record, the `TEST PAYMENT` line and `--json` say whether the test mode was declared or seen on the page. A failed `payment` step now leaves `Step.payment` unset until the first key is typed, and `test mode not detected` shows the declaration to write. (#611, #603, #604, #633)

- `possibleRealData` now names the path of a value in a JSON or form body, for example `in customerHashed.country`, and no longer says `in the body` for it. A multipart body is split into parts, and its text fields are scanned and named. When the body is binary as a whole, its binary parts are skipped and its text parts are still scanned. A multi-line body is checked line by line, so one compressed line no longer hides a text line. (#610, #620, #622, #623)

- A usage error now prints the message and one line, `Run tagreeve <command> --help for the options.`, not the full help text. `--help` still prints it. (#613)

### Fixed
- `run --baseline` compares scenario names without `.yml` or `.yaml`, so a baseline saved from `checkout` matches a run of `checkout.yml`. (#612)

- The baseline counts of added, removed and changed tuples come from the diff, so two tuples with the same change count as two. (#589)

- A baseline saved with sorted keys, for example by `jq -S`, compares the same. (#591)

- Hits that move across one consent answer, with the same total, are a warning and no longer drift. A move across two answers or a changed total is still drift. (#618)

- Baseline drift sets `pass` to false in the `--json` summary, as well as `ok`. (#590)

- `possibleRealData` no longer scans compressed or binary request bodies, such as a session-replay beacon. Bytes in them can look like an email by chance. The URL is still scanned, and a text body is scanned as before. (#614)

- `possibleRealData` now counts C1 control characters (0x80-0x9f) the same way for bodies as for base64 text: they are not binary. A body with 10% of them is now scanned. (#624)

- A form field with an empty name, such as `=value`, is placed in `the body` in a `possibleRealData` finding, not in a blank place. (#672)

- `identity.hashesMatch` no longer says a hit carried no identity fields when it carried only plain city, postal code or country. It now says the hit carried no hashed identity field, only plain fields that are not checked. (#595)

### Known in 0.4.0-rc.2

Issues still open that you can meet:

- The Shopify payment runtime is not yet checked on a real checkout: the test-mode marker, the card input selectors and the expiry format (`12/40` against a masked field). A supervised field test runs it with a declared host. If a value does not match, the step fails closed and a later release fixes it. Tests do not yet check the selectors or the order of the checks (#648).
- `earlyIdentifiers` is `warn` by default. The rc.2 field test decides whether it becomes `fail` for 0.4.0.
- The `--json` summary flags (`unknownDestination`, `firstPartySubdomain`, `stubBypass`, `possibleRedirectHop`) carry the full request URL, including query values. Do not share the summary from a page that sends an identifier in a query (#679).
- The verdict can hide a failed `deniedIdentifiers` when only early identifiers are named (#663).
- A text part of a multipart body that is typed as binary is reported `in the body`, not by its field name (#669).
- A mistyped option before the command loses the command name in the usage hint (#657), and the hint can name the wrong command (#644). Most per-command `--help` prints the general usage (#641). The unknown-option line is very long (#640).
- With two payment steps for different providers, the declaration hint names the first step's provider, not the one that failed (#647). The hint can also suggest an allowlist entry that the file refuses, which breaks later runs (#646). Check the hint before you copy it.
- The possible-real-data check merges two different emails or two different phones when one contains the other, so the count and the place are wrong (#667). A number prefix in a JSON path can be flagged as a phone (#668). The binary-share check counts UTF-16 units, not code points (#673).
- Playwright's request interception sometimes misses a redirect hop (#180). The `possibleRedirectHop` flag marks a likely miss in `stub` and `server` mode. `live` mode has no such flag.
- With `--net-log`, requests seen only in the net log are labelled by timing, and an early `srcdoc` iframe request can still read `unload` (#256).
- The leak check misses a URL-encoded email (#565).
- Platform infrastructure hosts fill the `unknownDestination` list (#585).
- A gap frame is requested twice when `mode` is given (#552).
- Server-to-vendor traffic is not visible to Tagreeve (#358), and several stores in one suite (#360) is planned. Both are deferred to 0.5.0.

Other open `review-minor` issues are test gaps, wording, or edge cases with no effect on a normal run. They carry the `review-minor` label.

## 0.4.0-rc.1

Release candidate. Install it with `npm i -g tagreeve@next`.

### Pingwright is now Tagreeve

The tool, the npm package, the command, the repository and the docs site have a new name. To move over:

1. `npm uninstall -g pingwright`
2. `npm i -g tagreeve@next`

Do the steps in this order. The old package owns the `pingwright` command link, so installing first fails with EEXIST.

- The command is `tagreeve`. The old name `pingwright` still runs the same CLI. It prints `pingwright is now tagreeve; this alias goes in 0.5.0` on stderr, and stdout and the exit code are the same.
- The docs are at https://tagreeve.dev and the code at https://github.com/alfhen/tagreeve. GitHub redirects the old repository links.
- Environment variables start with `TAGREEVE_`. The user config folder is `$XDG_CONFIG_HOME/tagreeve/`, else `~/.config/tagreeve/`.
- Records and scenarios need no change. Records keep the key `pingwrightVersion`, so older records still read, and the report labels it `Tagreeve`.

### Changes
- A `handoff` step can end by itself: `until` (a URL or an element), `settle` and `timeout`. The step record says what ended it in `handoffEnd`. `wait` takes `{ url }` too. (#515)
- New `payment` step: types a payment provider's documented test card (`shopify-bogus`, `shopify-test`) on a hosted store. It is opt-in with three checks: `--allow-test-payment <host>` equal to the `--site` host, the host in `~/.config/tagreeve/test-payment-hosts.json`, and the provider's test mode on the page. Log-ins stay handoff steps, and `fill`, `select` and `evaluate` still refuse card fields. From the first key until the run ends, non-tracking requests are redacted. The summary prints `TEST PAYMENT`. `suite` runs these scenarios only with `--with-test-payment` and `--allow-test-payment`. (#463, #529)
- New option `--viewport <W>x<H>` on `run` and `suite`, and `options.viewport` in the scenario. The record has `Run.viewport` and the report shows it. It sets the window size only: the user agent and client hints stay desktop. `mobile` and other values exit 2. (#514)
- `identity.country` now picks the format of the fake identity. GB and DE are added beside US and SE. A country with no format keeps US-shaped data and the run warns. (#32)
- A `fill` entry can be `{ value: phone, optional: true }`. A field that is not on the page is skipped, and the summary and `--json` list it. New option `optionalTimeout`. (#586)
- The real-phone warning says why the number looks real and names the fictional range for the country. German drama numbers get no warning. (#583)
- `tagreeve baseline save` keeps the shape of a run as names and counts, and `run --baseline` fails with exit 1 when a key or tuple appears or disappears. A missing or invalid baseline exits 2. (#359)
- Docs: design §8.5 says what is visible of a server container and what is not. `expectedTags` is stored and not evaluated. (#358)
- Docs: design §5.3 now has the measured rate of the missed redirect hop and its cause. Playwright's request interception drops the hop. New flag `possibleRedirectHop` marks a request handed to Chromium that either failed with `net::ERR_FAILED` and no response, or got a non-redirect status together with a `Location` header. It covers both shapes of a missed hop that were measured: a hop that fails CORS and a hop that allows it. The hop itself is still not recorded or stubbed. (#180)
- **Report: a segment with an early hit, a granted hit and a denied hit shows `mixed`.** It showed `early` and hid the denied hit.
- **Fixed.** `tagreeve report` on a suite with a malformed cell `failed` field now says it is not a suite manifest, instead of failing with a TypeError. (#506)
- **Fixed.** `tagreeve report` accepts the `--out` folder of `suite`. It uses the one `suite_*` folder inside and says which on stderr. With several, the error lists them. (#581)
- `possibleRealData` now names where the foreign value was found: the hit parameter path, `the URL` or `the body`. It never prints the value. (#582)
- `identity.hashesMatch` says when the hit carried no identity fields at all, and that server side matching is not visible to Tagreeve. A hit with fields that do not match keeps `Not matching: <field>`. (#584)

### Known in 0.4.0-rc.1

Issues still open that you can meet:

- Playwright's request interception sometimes misses a redirect hop (about 9 in 100 runs on a bare context with `route.continue`). That is the cause of #180. The new `possibleRedirectHop` flag marks a likely miss in `stub` and `server` mode. `live` mode has no such flag.
- With `--net-log`, requests seen only in the net log are labelled by timing, and an early `srcdoc` iframe request can still read `unload` (#256).
- Server-to-vendor traffic is not visible to Tagreeve. Design section 8.5 says what is and is not. The rest of #358, such as evaluating `expectedTags`, is planned for 0.5.0.
- `--viewport` takes `<W>x<H>` only. There is no `mobile` preset (#514).
- `identity.country` has local formats for US, SE, GB and DE. NL, DK, NO and other countries keep US-shaped data and the run warns.
- The `payment` step has not been checked on a real store. The Shopify values it relies on (the test-mode marker text, the card iframe selectors and the card host) may not match. If they do not, the step fails closed and types nothing.
- Platform infrastructure hosts fill the `unknownDestination` list (#585). Planned for 0.5.0.
- Several stores in one suite (#360) and `unloadGap` at the end of a run (#261) are deferred to 0.5.0.
- After a baseline drift, `pass` stays true while `ok` is false (#590). Read `ok`.
- Baseline matching depends on JSON property order (#591), and the summary counts come from deduplicated text lines (#589).
- `wait: { url }` matches any page, not only the active page (#569).
- The leak check misses a URL-encoded email (#565).
- `Step.payment` is set before any key is typed (#603). No test covers the Shopify payment runtime and the typed name (#604).
- The no-identity-fields message also fires for fields that were not checked (#595).
- A suite child without `suite.json` beside a valid one has no test (#593). No test checks that `suite` passes `--viewport` to its runs (#601). No leak test covers the new `skippedFields` output (#599).
- A gap frame is requested twice when `mode` is given (#552).
- Some e2e leak checks cannot fail: the SE `possibleRealData` check (#598), the baseline hash and cookie checks (#588), the handoff `until` check (#570) and the cookie already-set check (#543).
- Rename gaps: CI does not check that the old-name alias prints the version (#606), and the docs tell users to install `tagreeve` before it is on npm (#607). Use `npm i -g tagreeve@next` for this release.

Other open `review-minor` issues are wording or test gaps in the plan and design docs: #526, #531, #533, #535, #536, #538, #546, #555, #560, #561, #562 and #563.

## 0.3.0

`npm i -g pingwright` installs this release. 0.3.0 adds everything in 0.3.0-rc.1 and 0.3.0-rc.2 (below) and the changes under "Since rc.2". To upgrade from 0.2.0, read the first section.

### Upgrading from 0.2.0

- **A run that passed can now exit 1.** The `deniedIdentifiers` check is on by default with severity `fail`. It fails when an identifier goes out on a denied hit, or when a denied hit has a body that was not fully recorded. To keep exit code 0 while you fix the cause, set `options.builtins: { deniedIdentifiers: warn }`. See rc.1 below for the list of identifiers.
- **Record schema version 2.** 0.2 readers warn on a version 2 record. Version 1 records still read. All new fields hold names and numbers, never values.
- **New in the scenario format.** `body.has`, `body.only` and `body.ignore` rules on payload field names, `cookie` rules, `{ role, name }` and `{ any: [...] }` locators, and a `select` step. `body.has` and `body.only` take a leaf name such as `**.email`.
- **New commands.** `pingwright suite` runs a folder of scenarios once per variant and writes `suite.json`. `pingwright report` writes one HTML file for a run or a suite, with names and counts only, no script and no request.
- **New network mode.** `--network server` is `stub` plus pass-through for the hosts in `options.serverHosts`, so cookies set by a server container can be seen.
- **Handoff.** A headed handoff shows a Done button in the page. Enter in the terminal still works.
- **Output.** Every result in `--json` has `severity`. A result can have `note`, and the terminal summary prints it under the result.

### Since rc.2

#### Report

- The verdict names built-in checks apart from scenario rules: `no leaks; 1 rule failed; built-in check sandboxPageUrl failed in 4 runs`. It no longer says "failed expectations" (#511).
- The verdict and the timeline headers use plain vendor names, such as Google Analytics 4 and server container. Row headers read `Name (key)` (#512).
- The report title says what was tested, for example `Pingwright suite: published vs workspace on shop.example.com, 2026-10-31`. The suite ID is in the details list (#513).
- The verdict uses `sends` for one vendor (#505). The `unchecked` legend names the unknown-signal case (#497).

#### Terminal notes

- The text summary prints the note under a result, passing or failing, for example that a plain name matches a top-level field only. `--json` has the note code in `note` (#510, #520).

#### Cookie rule

- A `cookie` rule no longer says a cookie was stored by the browser when it was already set before the response. The message reads `the cookie was already set before this response`, with no `cookieNotStored` note. A checkpoint taken within 50 ms after the request no longer counts as evidence (#470, #485, #518).

### Known in 0.3.0

Issues still open that you can meet:

- Under the recorder, Playwright sometimes does not report a redirect response or the cross-origin request after it (4 of 30 runs in a live-mode probe; not seen in about 220 CI runs of the stub-mode redirect tests). A hit or cookie reached only through such a hop can be missing from the record, so a `mustNot` rule or a before-consent check can pass without seeing it. In `stub` mode the hop can reach the network with no `stubBypass` flag, but the request before it gets a `possibleRedirectHop` flag. Live mode has no such flag. In live mode, `--net-log` can record a collection request the recorder missed, without its body. It does not recover cookies (#180).
- The `country` option does not localise zip, phone or address (#32).
- With `--net-log`, only requests inside a navigation window are labelled `unload`. Requests seen only in the net log outside such a window get the initiator `netlog`. The label is a guess from timing, so an early `srcdoc` iframe request on a later page can still read `unload`. This corrects the rc.2 wording (#256, #323).
- `unloadGap` maps only a small table of Shopify standard event names to GA4 names, and a custom event name that no vendor answered is skipped. Other custom names are compared literally. This corrects the rc.2 wording (#261).
- In the report, a segment with `early`, granted and denied hits shows `early` and not `mixed` (#496).
- A hand-edited `suite.json` with a malformed failed cell makes `report` throw instead of saying it is not a suite manifest (#506).
- `docs/cli.md` says a locator timeout lists only controls of the requested role, but roles outside button, radio, checkbox, link, tab and option get the general list (#490).

Not in 0.3.0: opt-in test payment steps for unattended checkout runs (#463), server-container visibility, baselines for CI drift checks, one scenario across several stores, WebKit support and an MCP server (#358 to #362), and a better release setup (#144).

## 0.3.0-rc.2

Release candidate. Install it with `npm i -g pingwright@next`.

### Report marks and severity

- A hit with unknown consent before the first answer now has its own mark, `early`, ranked above `full`. A hit on a page with a denied Consent Mode default is still `ping` (#378).
- The marks table says that `unchecked` covers identifier names whose consent signal is unknown, and that a hit with both granted and denied signals shows `mixed` (#448).
- The report shows `on failure: fail` or `on failure: warn` on a failed or warned result only. A passing result shows no severity (#458).
- Every result in `--json` has `severity`. A rule with none recorded reads `fail` (#349).

### Suite and report layout

- A suite cell says what failed: `FAIL: 5 rules, deniedIdentifiers` or `WARN: 1 rule`. It counts the failed rules and names the failed built-in checks, and never prints a rule or a message. A run that did not finish stays `ERROR (exit 2)`. The terminal table and the report use the same text (#457).
- The report starts with a plain-language verdict, then the results table, the per-run vendor timelines and the diff tables last. The verdict names vendors, consent states and counts per variant. A single-run report has the same verdict line at the top (#459).
- `diff` and the suite diff tables print `unloadGap: 0 -> 1` for a flag with no host. "(no host)" is gone (#348).

### Cookie and body rules

- A `cookie` rule that finds a `Set-Cookie` header now says whether the browser kept the cookie: `found _dcid from Set-Cookie (7 requests); stored by the browser`, or `no later checkpoint has it` with `note: cookieNotStored`. The rule still fails on the attempt. The message shows names and counts only (#461).
- `body.has` and `body.only` take a leaf name, `**.email`, which matches `email` at any depth. A plain name still matches a top-level field only. When it matches nothing but a nested field has that name, the result says so and has `note: nestedNameOnly` (#462).

### Fixed

- `serverHosts` uses the Public Suffix List (`tldts`) to reject wildcards on public suffixes. `*.police.uk`, `*.uk.com`, `*.fly.dev` and `*.onrender.com` are now rejected, and `*.abc.de` is no longer rejected. `*.wordpress.com` stays rejected through a short local list (#427).
- A `click` or `wait` on a `{ role, name }` locator that times out now lists the closest controls of that role, ranked by name, for example `Closest radio controls: "White (01)", "Black (02)".` If the page has none of that role, the error says so first (#460).
- The Done pill calls the DOM accessors it needs at show and hide time from copies taken at document start, so a page that patches `textContent`, `style`, `getRootNode`, `String`, `Function.prototype.call` or `Event.prototype.stopPropagation` never sees the label or the host. The Done click reads `isTrusted` from a captured getter and treats a throw as untrusted (#446, #494, #398, #492).
- The Done pill is at most the viewport width minus 32 px, and a long handoff text shrinks before the Done button does (#464).

### Handoff

- A late "not waiting" answer no longer stops the Done pill polling after a wake, so the pill hides when the second handoff ends (#444).
- A stale "not waiting" answer no longer hides the Done pill while a handoff is waiting (#502, #500).
- A page that cannot answer the wake no longer blocks Enter or Done from ending a handoff (#445).
- Tests now show the pill stops asking for the handoff state when none is waiting, and asks again on the next handoff (#443).

### Docs

- The README says the 0.3 sections need `npm i -g pingwright@next`, and that the plain install gives 0.2.0 (#450, #481).
- The Shopify guide says a handoff ends when the person clicks Done or presses Enter (#449).
- The handoff docs say a `body` rule does not hide the Done pill, because the host is a sibling of `<body>`. A rule such as `html { display: none }` can still hide it (#454, #480).
- The docs no longer say Enter always works (#451).
- Design section 11 lists `deniedIdentifiers` as a built-in check (#455).
- `docs/cli.md` says only a `--net-log` POST hit has no body (#479).

### Known in 0.3.0-rc.2

Not in rc.2:

- Opt-in test payment steps for unattended checkout runs (#463).
- Server-container visibility, baselines for CI drift checks, one scenario across several stores, WebKit support and an MCP server (#358 to #362).
- A better release setup (#144).

Known issues in rc.2:

- The recorder sometimes misses a redirect response and the cross-origin hop after it. In `stub` mode such a hop can reach the network with no record and no `stubBypass` flag (#180).
- The `country` option does not localise zip, phone or address (#32).
- With `--net-log`, requests seen only in the net log are all labelled with initiator `unload`, and early `srcdoc` requests can be labelled `unload` (#256, #323).
- `unloadGap` compares dataLayer event names to hit names literally (#261).
- A cookie set by a response still in flight at the last checkpoint can read as `cookieNotStored` (#485).
- In the report, a segment with `early`, granted and denied hits shows `early` and not `mixed` (#496).
- The report legend for `unchecked` does not mention identifier names whose consent signal is unknown (#497).
- The verdict says "send" for a single vendor (#505).
- A hand-edited `suite.json` with a malformed failed cell makes `report` throw instead of saying it is not a suite manifest (#506).
- `docs/cli.md` says a locator timeout lists only controls of the requested role, but roles outside button, radio, checkbox, link, tab and option get the general list (#490).

## 0.3.0-rc.1

Release candidate. Install it with `npm i -g pingwright@next`.

### Exit codes can change

The new `deniedIdentifiers` check is on by default and its severity is `fail`. A run that sent an identifier on a denied hit passed in 0.2 and now exits 1. Identifiers are `user_id`, `uid`, hashed `user_data` fields, client-ID hashes, and any field with a 64-character hex value. To keep exit code 0 while you fix the cause, set the check to `warn`:

```yaml
options:
  builtins: { deniedIdentifiers: warn }
```

The check also fails when a denied hit has a body that was not fully recorded: cut at 64 KiB, JSON that did not parse, or a `--net-log` hit with no body. `cid`, `client_id`, `fbp` and click IDs are not flagged. See "deniedIdentifiers" in [docs/cli.md](docs/cli.md).

### Record schema version 2

- `Run.recordSchemaVersion` is 2. 0.2 readers warn on it. Version 1 records still read.
- New optional fields: `Hit.fields` (names of non-empty payload fields), `Hit.fieldsComplete`, `Hit.idFields`, `Checkpoint.t`, `Run.graceWindowMs`, `Run.variant`, `Result.note` and `Step.locator`. They hold names and numbers, never values.
- A rule that needs field names and finds a version 1 record, or a body cut at 64 KiB, reports `cannot evaluate` and does not pass, unless the recorded fields already decide the rule.

### New rules and checks

- `body.has`, `body.only` and `body.ignore` check the field names of a hit, with `*` globs. `body.only` applies to every selected hit.
- `cookie` checks cookie names with `before`, `in` and `after`. In `stub` mode a pass carries the note `stubNoCookies`.
- `deniedIdentifiers` is a built-in check. `options.identifierFields` adds names to it.

### New commands

- `pingwright suite <dir> --site <url>` runs every scenario once per variant (`--variant published`, `--variant name=override.json`), prints a table with the diff between variants, and writes `suite.json`. Scenarios with a `handoff` step are skipped unless `--with-handoff` is given.
- `pingwright report <run.jsonl | suite dir> --html <out.html>` writes one HTML file with names and counts only. It has no script and makes no request.

### New steps and handoff

- `click` and `wait` accept `{ role, name }` and `{ any: [selectors] }`. A timeout lists the closest controls on the page.
- `select` chooses an option by value, then by label, and reads it back.
- A headed handoff shows a Done button in the page. Enter in the terminal still works.

### Server network mode

`--network server` is `stub` plus pass-through for the hosts in `options.serverHosts`. Every other collection request is still stubbed. It exists so that cookies set by a server container can be seen. Sends a page makes while it unloads are still answered in the page, also to server hosts.

Known in 0.3.0-rc.1, fixed in 0.3.0-rc.2:

- `diff` prints `unloadGap (no host)` for flags without a host (#348).
- In `--json` output, `expect` results have no `severity` (#349).
- Enter in the terminal can fail to end a handoff when a page does not answer the wake call (#445).

## 0.2.0

Added a GTM workspace override (`--gtm-override`, also through a Stape-style custom loader), `pingwright diff`, a Pinterest decoder, a curated tracker list that is stubbed and decoded, `--net-log`, the `builtins` severity option, and a Shopify checkout pattern.

Notes:

- In `stub` mode, a hit that a sandboxed frame without `allow-same-origin` (such as a Shopify custom pixel) sends while it unloads is not recorded. Pingwright raises an `unloadGap` warning. To record it, run with `--network live --net-log`. Unload sends from other frames are answered in the page and recorded, unless the tab goes to another origin.
- For Shopify custom pixels, set `builtins: { sandboxPageUrl: warn }`. The pixel runs in a sandboxed iframe, and a vendor that receives the sandbox URL as the page URL is a defect to report, not to fail on.
- A failed `identity.hashesMatch` names the params that do not match and the fields that do (#347).

Known in 0.2.0:

- `diff` prints `unloadGap (no host)` for flags without a host (#348).
- In `--json` output, `expect` results have no `severity`, so a script reads `null` (#349).
